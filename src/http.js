// fetch wrapper with retry/backoff for 429 and transient 5xx. Used by HubSpot and Shopify clients.
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestWithBackoff(url, init, { fetchImpl = fetch, sleep = defaultSleep, maxRetries = 6, label = 'request' } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (err) {
      if (attempt >= maxRetries) throw new Error(`${label}: network error: ${err.message}`);
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) {
        throw new Error(`${label}: gave up after ${attempt + 1} attempts (HTTP ${res.status})`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
      console.warn(`${label}: HTTP ${res.status}, retrying in ${Math.round(wait)}ms (attempt ${attempt + 1}/${maxRetries})`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      throw new Error(`${label}: HTTP ${res.status} ${detail}`);
    }
    return res;
  }
}

function backoffMs(attempt) {
  return Math.min(30000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

module.exports = { requestWithBackoff, defaultSleep };
