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

// Status of a company (or an individual contact):
//   grey   never purchased (no closed-won deal), whatever the contact history
//   green  last purchase within recentDays
//   ice    last purchase coldDays or more ago ("gone cold"; replaces yellow/red)
//   yellow bought before (recentDays..coldDays ago) and contacted within recentDays
//   red    bought before (recentDays..coldDays ago) and not contacted within recentDays
function computeStatus({ lastPurchase, lastContacted }, { now = Date.now(), recentDays = 90, coldDays = 365 } = {}) {
  const bought = toTime(lastPurchase);
  if (bought == null) return 'grey';
  if (isRecent(lastPurchase, now, recentDays)) return 'green';
  if (now - bought >= coldDays * DAY_MS) return 'ice';
  return isRecent(lastContacted, now, recentDays) ? 'yellow' : 'red';
}

module.exports = { DAY_MS, toTime, latestDate, isRecent, computeStatus };
