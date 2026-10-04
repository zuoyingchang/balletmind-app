process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { KNOWN_EVENTS } = require('../events');

test('every event name the web app reports is accepted by the server (unknown names are rejected with 400)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  const names = [...new Set([...html.matchAll(/logEvent\('([a-z_]+)'/g)].map((m) => m[1]))];
  assert.ok(names.length >= 8, 'expected to find the web app logEvent calls');
  const rejected = names.filter((n) => !KNOWN_EVENTS.has(n));
  assert.deepEqual(rejected, [], `server would drop these events: ${rejected.join(', ')}`);
});
