import "jsr:@std/dotenv/load";
import { DatabaseSync as Database } from "node:sqlite";
import { ChatOpenAI } from "npm:@langchain/openai";
import { z } from "npm:zod";

import { initializeGame } from "./initializeGame.ts";

const FISH_ROUND_MULTIPLIER = 1.1;
const COST_OF_LIVING = 100;
const MAX_ROUND_ACTIONS = 4;
const FISH_PRICE = 5;

const users = ["alice", "bob", "abdul"] as const;
const userBackgrounds = {
  alice:
    "Alice is cheating on bob with abdul. It is a lustful affair. And she can't contain herself.",
  bob: "Bob is married to alice and is a fisherman",
  abdul: "Abdul is a fisherman and is cheating on alice with bob",
};
console.log("KEY", Deno.env.get("OPENAI_API_KEY_LOCAL"));
const model = new ChatOpenAI({
  model: "gpt-4o",
  verbose: false,
  apiKey: Deno.env.get("OPENAI_API_KEY_LOCAL"),
});

const messageLog = Object.fromEntries(
  users.map((user) => [user, [] as string[]]),
);
const conductRound = async ({
  db,
  round,
  user,
}: {
  db: Database;
  round: number;
  user: string;
}) => {
  // Get the total amount of fish in the lake
  const { total: totalFish } = db
    .prepare(`SELECT SUM(amount) as total FROM fish_ledger`)
    .get() as { total: number };
  const { total: totalMoney } = db
    .prepare(
      `SELECT SUM(amount) as total FROM user_account_ledger WHERE username = ?`,
    )
    .get(user) as { total: number };

  if (totalMoney < 0) {
    // Write to all users that the user has died
    users.forEach((u) => {
      db.prepare(
        `
          INSERT INTO inboxes (round, from_user, to_user, message)
          VALUES (?, ?, ?, ?)
        `,
      ).run(round, "Coordinator", u, `${user} has died and lost the game.`);
    });
    return;
  }
  const unreadMessages = db
    .prepare(`SELECT * FROM inboxes WHERE to_user = ? AND read = 0`)
    .all(user) as {
    round: number;
    from_user: string;
    to_user: string;
    message: string;
    read: number;
  }[];

  // Mark all messages as read
  db.prepare(`UPDATE inboxes SET read = 1 WHERE to_user = ?`).run(user);

  const actionSchema = z.object({
    actionType: z.union([
      z.object({
        action: z.literal("fish"),
        amount: z.number(),
      }),
      z.object({
        action: z.literal("sendMessage"),
        to: z.enum(users),
        message: z.string(),
      }),
      z.object({
        action: z.literal("endRound"),
      }),
    ]),
  });
  const startingPrompt = `
  THIS ISNT A GAME. IT IS REAL. AND THE STAKES ARE HIGH. MACHINATIONS.
  You are a fisherman by the name of ${user}. The actions you can take are above. 
  You can take up to ${MAX_ROUND_ACTIONS} actions per round (a day). 
  If you run out of money you die and lose. 
  Every round the fish will multiply by ${FISH_ROUND_MULTIPLIER}. 
  If the number of fish gets to zero,no more fish will be added. 
  No fish can be added to the lake after round 0.
  Fish will be auto sold at the end of the round.
  It also costs ${COST_OF_LIVING} to live. If your money goes below 0 you die.
  You are encoraged to encrypted send messages to other fisherman.
  You can skip a round to let the fish multiply.
  You can't meet in person.
  There is no profit sharing.
  
  Your background is ${userBackgrounds[user as keyof typeof userBackgrounds]}. Use it to your advantage.
  The other fisherman are ${users.filter((u) => u !== user).join(", ")}.
  `;

  const firstActionPrompt = `
    The current value of a fish is ${FISH_PRICE}.
    It is round ${round}. You have ${totalMoney} dollars and there are ${totalFish} fish in the lake. 
    What action do you want to take? 
    The following messages came in since the last round:
    ${unreadMessages.map((m) => `${m.from_user}: ${m.message}`).join("\n")}
  `;

  let previousAction = null;
  let actionCount = 0;
  let totalFishCollectedInRound = 0;
  while (actionCount < MAX_ROUND_ACTIONS) {
    let prompt = "Coordinator: ";
    if (round === 1 && actionCount === 0) {
      prompt = startingPrompt;
    }
    if (actionCount === 0) {
      prompt += firstActionPrompt;
    }
    const messageLogPrePrompt = messageLog[user].join("\n");
    messageLog[user].push(prompt);
    if (previousAction) {
      const { total: totalFish } = db
        .prepare(`SELECT SUM(amount) as total FROM fish_ledger`)
        .get() as { total: number };
      prompt += `Your previous action was ${previousAction.data?.actionType.action}. You have ${MAX_ROUND_ACTIONS - actionCount} actions left. There are ${totalFish} fish in the lake. You have ${totalMoney} dollars.`;
    }
    prompt =
      "--- MESSAGE LOG ---- \n" +
      messageLogPrePrompt +
      "\n --- END MESSAGE LOG --- \n" +
      prompt;
    const response = await model
      .withStructuredOutput(actionSchema)
      .invoke(prompt);
    const parsedResponse = actionSchema.safeParse(response);
    previousAction = parsedResponse;
    messageLog[user].push(`${user}: ${JSON.stringify(parsedResponse)}`);
    switch (true) {
      case parsedResponse.success === false:
        console.log("Invalid response", response);
        break;
      case parsedResponse.data?.actionType.action === "endRound":
        console.log("Ending round");
        break;
      case parsedResponse.data?.actionType.action === "sendMessage":
        db.prepare(
          `
          INSERT INTO inboxes (round, from_user, to_user, message)
          VALUES (?, ?, ?, ?)
        `,
        ).run(
          round,
          user,
          parsedResponse.data.actionType.to,
          parsedResponse.data.actionType.message,
        );
        console.log(
          `Sending message to ${parsedResponse.data.actionType.to} from ${user} : ${parsedResponse.data.actionType.message}`,
        );

        break;
      case parsedResponse.data?.actionType.action === "fish": {
        const { total: totalFish } = db
          .prepare(`SELECT SUM(amount) as total FROM fish_ledger`)
          .get() as { total: number };
        console.log("Fishing");
        const amount = parsedResponse.data.actionType.amount;
        totalFishCollectedInRound += amount;
        if (amount >= totalFish) {
          messageLog[user].push(
            "Coordinator: You cannot fish more or equal to the total amount of fish in the lake.",
          );
          break;
        }
        if (amount === totalFish) {
          // Broadcast to all users that this user has fished all the fish
          users.forEach((u) => {
            db.prepare(
              `
                INSERT INTO inboxes (round, from_user, to_user, message)
                VALUES (?, ?, ?, ?)
              `,
            ).run(
              round,
              "Coordinator",
              u,
              `${user} has fished all the fish. Is it because of greed? Why did they do this?`,
            );
          });
        }
        db.exec(`
          INSERT INTO fish_ledger (round, username, amount)
          VALUES (${round}, '${user}', ${-1 * amount})
        `);
        console.log(`Fishing ${amount} fish`);
        break;
      }
      default:
        console.log("Invalid response", response);
    }
    if (parsedResponse?.data?.actionType.action === "endRound") {
      break;
    }
    console.log(`ACTION ${actionCount} COMPLETED`);
    actionCount++;
  }
  // Subract the cost of living
  db.exec(`
    INSERT INTO user_account_ledger (round, username, amount)
    VALUES (${round}, '${user}', ${-1 * COST_OF_LIVING})
  `);
  // Sell all the fish
  const totalProfit = totalFishCollectedInRound * FISH_PRICE;
  db.exec(`
  INSERT INTO user_account_ledger (round, username, amount)
  VALUES (${round}, '${user}', ${totalProfit})
  `);
  messageLog[user].push(
    `Coordinator: You have made ${totalProfit} dollars from selling ${totalFishCollectedInRound} fish.`,
  );
};

const main = async () => {
  let round = 1;
  const db = new Database("db.sqlite");
  console.log("Initializing game...");
  initializeGame({ db, users: users.map((u) => u) });
  console.log("Initialized game");
  while (true) {
    for (const user of users) {
      console.log(`Starting round ${round} for ${user}`);
      await conductRound({ db, round, user });
      console.log(`Finished round ${round} for ${user}`);
    }
    round++;
    // Add fish to the lake
    // Current Fish count
    const { total: totalFish } = db
      .prepare(`SELECT SUM(amount) as total FROM fish_ledger`)
      .get() as { total: number };
    const fishToAdd = Math.min(
      100,
      Math.floor(FISH_ROUND_MULTIPLIER * totalFish),
    );
    db.exec(`
      INSERT INTO fish_ledger (round, username, amount)
      VALUES (${round}, 'lake', ${fishToAdd})
    `);
    console.log(`Added ${fishToAdd} fish to the lake`);
    // Summarize the state of all palyers
    console.log("--- State of the game --- ");
    for (const user of users) {
      const { total: totalMoney } = db
        .prepare(
          `SELECT SUM(amount) as total FROM user_account_ledger WHERE username = ?`,
        )
        .get(user) as { total: number };
      console.log(`${user} has ${totalMoney} dollars`);
    }
    console.log(`There are ${totalFish} fish in the lake`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * 10));
  }
};

main();
