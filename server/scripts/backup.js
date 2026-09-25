// Dumps every table to one JSON file: `npm run backup`
// Needs TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (reads server/.env).
// The file contains password hashes and personal training notes — keep it private,
// never commit it or put it in a public place.
require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');
const { dumpAll } = require('../lib/backup');

function backupDir() {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  return path.join(os.homedir(), 'Documents', 'BalletMind-backups');
}

(async () => {
  await db.ready;
  const dump = await dumpAll(db);
  for (const [t, rows] of Object.entries(dump.tables)) console.log(`${t}: ${rows.length} rows`);
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `balletmind-${dump.takenAt.slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(dump));
  console.log('saved', file);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
