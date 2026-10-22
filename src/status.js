// Pure status logic. No I/O, so it is easy to unit test.
const DAY_MS = 86400000;

// HubSpot returns dates as ISO strings or epoch-millisecond strings, depending on property.
function toTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// Most recent of the given date-ish values, as an ISO string (or null).
function latestDate(...values) {
  let best = null;
  for (const v of values) {
    const t = toTime(v);
    if (t != null && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

function isRecent(value, now, recentDays) {
  const t = toTime(value);
  if (t == null) return false;
  return now - t <= recentDays * DAY_MS; // future dates (clock skew) count as recent
}

// GREEN: recent purchase. YELLOW: no recent purchase but recently contacted. RED: neither.
function computeStatus({ lastPurchase, lastContacted }, { now = Date.now(), recentDays = 90 } = {}) {
  if (isRecent(lastPurchase, now, recentDays)) return 'green';
  if (isRecent(lastContacted, now, recentDays)) return 'yellow';
  return 'red';
}

module.exports = { DAY_MS, toTime, latestDate, isRecent, computeStatus };
