const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ready = client.batch(
  [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      created_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      class_name TEXT,
      transcript TEXT,
      good_points TEXT,
      improve_points TEXT,
      next_time_reminder TEXT,
      confidence_level TEXT,
      note TEXT,
      duration_sec INTEGER,
      created_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      event_name TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER
    )`,
    // Recurring Issue Tracking (V0.2 #1): detection is pure text matching, never
    // AI — status is only ever changed by the user themselves.
    `CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      first_record_id INTEGER,
      last_record_id INTEGER,
      created_at INTEGER,
      updated_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS issue_occurrences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_id INTEGER NOT NULL,
      record_id INTEGER NOT NULL,
      created_at INTEGER
    )`,
    // Terminology correction memory (V0.2 #12): the user explicitly tells us
    // "AI got this term wrong", never inferred by diffing their edits.
    `CREATE TABLE IF NOT EXISTS term_corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      wrong_term TEXT NOT NULL,
      correct_term TEXT NOT NULL,
      created_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
  ],
  'write'
);

async function get(sql, args = []) {
  const { rows } = await client.execute({ sql, args });
  return rows[0];
}

async function all(sql, args = []) {
  const { rows } = await client.execute({ sql, args });
  return rows;
}

// lastInsertRowid comes back as a bigint from libsql — converted to a plain
// number here since callers pass it straight into res.json() / jwt.sign().
async function run(sql, args = []) {
  const result = await client.execute({ sql, args });
  return {
    lastInsertRowid: result.lastInsertRowid === undefined ? undefined : Number(result.lastInsertRowid),
    changes: result.rowsAffected,
  };
}

module.exports = { ready, get, all, run };
