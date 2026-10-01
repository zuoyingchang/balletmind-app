// Abort a hung upstream call so our request does not wait forever.
//
// AbortController alone is not enough: reproduced live against DeepSeek, a
// call hung for 8m19s despite a 25s abort firing on schedule -- when the
// stall is at connect/DNS time (packets silently dropped) rather than mid-
// response, Node's fetch (undici) does not reliably reject promptly on
// abort in this environment/version. Race the real fetch against an
// independent timer so OUR code always gives up on time; the abort() call
// still runs (best-effort real cancellation), but the timing guarantee
// comes from the race, not from trusting the signal to be honored.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let hardTimer;
  const hardTimeout = new Promise((resolve, reject) => {
    hardTimer = setTimeout(() => {
      const err = new Error('fetch_hard_timeout');
      err.name = 'AbortError';
      reject(err);
    }, timeoutMs + 1000);
  });
  try {
    return await Promise.race([fetch(url, { ...options, signal: controller.signal }), hardTimeout]);
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
  }
}

function isAbortError(err) {
  return err && err.name === 'AbortError';
}

module.exports = { fetchWithTimeout, isAbortError };
