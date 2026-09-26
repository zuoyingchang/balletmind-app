// Removes issue_occurrences rows whose issue no longer exists (nothing can ever
// display or count them). Dry run by default:
//   node scripts/cleanup-orphan-occurrences.js          -> only reports
//   node scripts/cleanup-orphan-occurrences.js --apply  -> deletes them
// Take a backup first (`npm run backup`). Rows whose record is missing but whose issue
// still exists are only reported, never touched here.
require('dotenv').config();
const db = require('../db');

(async () => {
  await db.ready;
  const noIssue = await db.get('SELECT COUNT(*) AS c FROM issue_occurrences WHERE issue_id NOT IN (SELECT id FROM issues)');
  const noRecordButIssue = await db.get(
    'SELECT COUNT(*) AS c FROM issue_occurrences WHERE record_id NOT IN (SELECT id FROM records) AND issue_id IN (SELECT id FROM issues)'
  );
  console.log(`occurrences pointing at a deleted issue: ${noIssue.c}`);
  console.log(`occurrences pointing at a deleted record but a live issue (left alone): ${noRecordButIssue.c}`);
  if (process.argv.includes('--apply')) {
    await db.run('DELETE FROM issue_occurrences WHERE issue_id NOT IN (SELECT id FROM issues)');
    const left = await db.get('SELECT COUNT(*) AS c FROM issue_occurrences WHERE issue_id NOT IN (SELECT id FROM issues)');
    console.log(`deleted. remaining orphans: ${left.c}`);
  } else {
    console.log('dry run only. re-run with --apply to delete.');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
