// Restores a backup file into an EMPTY database:
//   1. create a new (empty) Turso database and put its URL/token in server/.env
//      (or export TURSO_DATABASE_URL / TURSO_AUTH_TOKEN for this one command)
//   2. npm run restore -- ../backups/balletmind-2026-09-25.json
// It refuses to run if any table already has rows, so it can never overwrite live data.
require('dotenv').config();
const fs = require('fs');
const db = require('../db');
const { restoreAll } = require('../lib/backup');

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: npm run restore -- <backup.json>'); process.exit(1); }
  await db.ready;
  const dump = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`backup taken at ${dump.takenAt}`);
  const restored = await restoreAll(db, dump);
  for (const [t, n] of Object.entries(restored)) console.log(`${t}: restored ${n} rows`);
  console.log('done');
  process.exit(0);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
