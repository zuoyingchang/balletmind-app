// Dump / restore every table as plain JSON rows. `db` is anything with all/get/run
// (the app's ../db module, or a stub in tests).
const TABLES = ['users', 'records', 'issues', 'issue_occurrences', 'events', 'term_corrections', 'password_reset_tokens', 'feedback'];

async function dumpAll(db) {
  const dump = { takenAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) dump.tables[t] = await db.all(`SELECT * FROM ${t}`);
  return dump;
}

// Restores into an EMPTY database only, so a restore can never overwrite or
// duplicate live data. Original ids are kept, so records / issues / occurrences
// stay linked to each other.
async function restoreAll(db, dump) {
  if (!dump || !dump.tables) throw new Error('not a BalletMind backup file');
  for (const t of TABLES) {
    const row = await db.get(`SELECT COUNT(*) AS c FROM ${t}`);
    if (row.c > 0) throw new Error(`refusing to restore: table "${t}" already has ${row.c} rows (restore into an empty database)`);
  }
  const restored = {};
  for (const t of TABLES) {
    const rows = dump.tables[t] || []; // older backups may not have every table
    for (const r of rows) {
      const cols = Object.keys(r);
      await db.run(
        `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => r[c])
      );
    }
    restored[t] = rows.length;
  }
  return restored;
}

module.exports = { TABLES, dumpAll, restoreAll };
