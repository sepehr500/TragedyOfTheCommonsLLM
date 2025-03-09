import { DatabaseSync as Database } from "node:sqlite";

export const initializeGame = ({
  db,
  users,
}: {
  db: Database;
  users: string[];
}) => {
  const TABLES = ["fish_ledger", "inboxes", "user_account_ledger"];
  // Drop all the tables
  for (const table of TABLES) {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  // Clear all the tables
  db.exec(`
  CREATE TABLE IF NOT EXISTS fish_ledger (
    round INTEGER,
    username TEXT,
    amount INTEGER
  )
`);

  // We will sum the amount in this column to get the total amount. Index so that is fast
  db.exec(`
  CREATE INDEX IF NOT EXISTS idx_amount ON fish_ledger (amount)
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS inboxes (
    round INTEGER,
    from_user TEXT,
    to_user TEXT,
    message TEXT,
    read INTEGER DEFAULT 0
  )
`);

  db.exec(`
  CREATE TABLE IF NOT EXISTS user_account_ledger (
    round INTEGER,
    username TEXT,
    amount INTEGER
  )
`);
  for (const table of TABLES) {
    db.exec(`DELETE FROM ${table}`);
  }
  // Add 100 fish to the lake on round 0
  db.exec(`
    INSERT INTO fish_ledger (round, username, amount)
    VALUES (0, 'lake', 100)
  `);
  // Give each user 500 dollars
  for (const user of users) {
    db.exec(`
      INSERT INTO user_account_ledger (round, username, amount)
      VALUES (0, '${user}', 500)
    `);
  }
};
