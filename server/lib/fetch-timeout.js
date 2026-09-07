// Abort a hung upstream call so our request does not wait forever.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(err) {
  return err && err.name === 'AbortError';
}

module.exports = { fetchWithTimeout, isAbortError };
