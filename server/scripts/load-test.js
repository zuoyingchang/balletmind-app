// Local scale test — seeds a throwaway libsql file (same engine as production
// Turso) and times the three query patterns the app actually runs in
// production code paths:
//   1. single-user record list  (routes/records.js  GET /)
//   2. daily AI-quota check     (events.js          countAiCallsToday)
//   3. admin dashboard totals   (admin-stats.js      buildStats)
//
// Never touches the real database — everything happens in a fresh temp file
// that's deleted when the script exits. Re-run any time to re-validate index
// choices as the app grows past this session's numbers.
//
// Usage: node server/scripts/load-test.js [userCount] [recordsPerUser] [eventsPerUser]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@libsql/client');

const USERS = Number(process.argv[2]) || 100;
const RECORDS_PER_USER = Number(process.argv[3]) || 20;
const EVENTS_PER_USER = Number(process.argv[4]) || 6;

const EVENT_NAMES = [
  'record_voice_start', 'asr_success', 'ai_process_success',
  'review_opened', 'save_record', 'history_open',
];

function randInt(n) {
  return Math.floor(Math.random() * n);
}

async function main() {
  const dbFile = path.join(os.tmpdir(), `balletmind-load-test-${Date.now()}.db`);
  const client = createClient({ url: `file:${dbFile}` });

  console.log(`规模：${USERS} 用户 × ${RECORDS_PER_USER} 条记录 × ${EVENTS_PER_USER} 事件`);
  console.log(`（临时库：${dbFile}）\n`);

  // Same schema + indexes as server/db.js — keep these two in sync by hand
  // if db.js changes.
  await client.batch(
    [
      `CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        created_at INTEGER
      )`,
      `CREATE TABLE records (
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
        training_duration_min INTEGER,
        created_at INTEGER
      )`,
      `CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        event_name TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER
      )`,
      'CREATE INDEX idx_records_user ON records(user_id)',
      'CREATE INDEX idx_events_user ON events(user_id)',
    ],
    'write'
  );

  console.log('灌数据中...');
  const seedStart = Date.now();
  const now = Date.now();
  for (let u = 0; u < USERS; u++) {
    await client.execute({
      sql: 'INSERT INTO users (email, created_at) VALUES (?, ?)',
      args: [`load-test-${u}@example.com`, now],
    });
    const userId = u + 1;
    const stmts = [];
    for (let r = 0; r < RECORDS_PER_USER; r++) {
      stmts.push({
        sql: `INSERT INTO records
          (user_id, class_name, transcript, good_points, improve_points, next_time_reminder, confidence_level, note, duration_sec, training_duration_min, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [userId, '训练记录', '转写文本...'.repeat(20), '要点', '待改进', '下次提醒', '中', '备注', 60, 45, now - randInt(90 * 86400000)],
      });
    }
    for (let e = 0; e < EVENTS_PER_USER; e++) {
      stmts.push({
        sql: 'INSERT INTO events (user_id, event_name, metadata, created_at) VALUES (?, ?, ?, ?)',
        args: [userId, EVENT_NAMES[randInt(EVENT_NAMES.length)], null, now - randInt(90 * 86400000)],
      });
    }
    await client.batch(stmts, 'write');
  }
  console.log(`灌数据耗时：${Date.now() - seedStart}ms\n`);

  async function timeQuery(label, fn, runs = 20) {
    const times = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await fn();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(`${label}：avg ${avg.toFixed(2)}ms | p50 ${times[Math.floor(times.length / 2)].toFixed(2)}ms | max ${times[times.length - 1].toFixed(2)}ms`);
  }

  const sampleUserId = 1 + randInt(USERS);

  await timeQuery('单用户查记录 (GET /api/records)', () =>
    client.execute({ sql: 'SELECT * FROM records WHERE user_id = ? ORDER BY created_at DESC', args: [sampleUserId] }));

  await timeQuery('每日配额检查 (countAiCallsToday)', () =>
    client.execute({
      sql: `SELECT COUNT(*) AS c FROM events
            WHERE user_id = ? AND event_name IN ('ai_process_success','ai_process_fail','asr_success','asr_fail') AND created_at >= ?`,
      args: [sampleUserId, 0],
    }));

  await timeQuery('后台看板全量统计 (users+records+events 全表聚合)', async () => {
    await client.execute('SELECT COUNT(*) AS c FROM users');
    await client.execute('SELECT COUNT(*) AS c FROM records');
    await client.execute('SELECT COUNT(*) AS c FROM events');
    await client.execute({ sql: 'SELECT COUNT(*) AS c FROM records WHERE created_at >= ?', args: [0] });
    await client.execute({ sql: 'SELECT COUNT(*) AS c FROM events WHERE created_at >= ?', args: [0] });
    await client.execute(`SELECT event_name, COUNT(*) AS count FROM events GROUP BY event_name`);
    await client.execute("SELECT metadata FROM events WHERE event_name = 'ai_process_success'");
  }, 10);

  client.close();
  fs.rmSync(dbFile, { force: true });
  fs.rmSync(`${dbFile}-wal`, { force: true });
  fs.rmSync(`${dbFile}-shm`, { force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
