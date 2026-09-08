const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ready = client.batch(
  [
    // NOTE: `records.duration_sec` is the length of the VOICE MEMO, not how
    // long the user actually trained — do not use it for "training hours"
    // stats. `training_duration_min` (added via migration below) is the
    // user-provided, optional, real training duration.
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
).then(async () => {
  try {
    await client.execute('ALTER TABLE records ADD COLUMN training_duration_min INTEGER');
  } catch (e) {
    // Already applied in a previous deploy/restart — idempotent, safe to ignore.
    // Any other failure here is unexpected and should still surface.
    if (!/duplicate column/i.test(e.message || '')) throw e;
  }
});

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
