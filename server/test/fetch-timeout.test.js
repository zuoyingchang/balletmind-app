const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { fetchWithTimeout, isAbortError } = require('../lib/fetch-timeout');

test('a normal, fast response resolves well under the timeout', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const port = server.address().port;
    const res = await fetchWithTimeout(`http://localhost:${port}/`, {}, 2000);
    assert.equal(await res.text(), 'ok');
  } finally {
    server.close();
  }
});

// Reproduces the real incident: a request to DeepSeek was observed to hang
// for 8m19s despite a 25s AbortController timeout -- Node's fetch does not
// reliably reject promptly on abort when the stall happens at connect time
// rather than mid-response. This server accepts the connection and then
// never writes a response, so the timeout can only be enforced by the race
// against an independent timer, not by trusting the abort signal alone.
test('a connection that never responds is cut off at the timeout, not left hanging', async () => {
  const server = http.createServer(() => { /* never respond */ });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const port = server.address().port;
    const started = Date.now();
    await assert.rejects(
      () => fetchWithTimeout(`http://localhost:${port}/`, {}, 500),
      (e) => isAbortError(e)
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `expected cutoff well under 2s, took ${elapsed}ms`);
  } finally {
    server.close();
  }
});

test('isAbortError recognizes both the real AbortError and the hard-timeout fallback', () => {
  assert.equal(isAbortError({ name: 'AbortError' }), true);
  assert.ok(!isAbortError(new Error('something else')));
  assert.ok(!isAbortError(null));
});
