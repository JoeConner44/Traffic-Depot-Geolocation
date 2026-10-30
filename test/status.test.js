const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStatus, latestDate, toTime, DAY_MS } = require('../src/status');

const NOW = Date.parse('2026-06-01T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY_MS).toISOString();
const status = (p, c, opts = {}) => computeStatus({ lastPurchase: p, lastContacted: c }, { now: NOW, recentDays: 90, coldDays: 365, ...opts });

test('grey: never purchased, however recently contacted', () => {
  assert.equal(status(null, null), 'grey');
  assert.equal(status(null, ago(3)), 'grey');
  assert.equal(status(undefined, ago(400)), 'grey');
});
test('green: recent purchase wins, whatever the contact date', () => {
  assert.equal(status(ago(10), null), 'green');
  assert.equal(status(ago(10), ago(400)), 'green');
});
test('yellow: bought before (recent..cold window) and contacted recently', () => {
  assert.equal(status(ago(200), ago(30)), 'yellow');
});
test('red: bought before (recent..cold window) and not contacted recently', () => {
  assert.equal(status(ago(200), ago(200)), 'red');
  assert.equal(status(ago(200), null), 'red');
});
test('ice: last purchase coldDays or more ago, regardless of contact', () => {
  assert.equal(status(ago(400), ago(2)), 'ice');
  assert.equal(status(ago(900), null), 'ice');
});
test('boundaries: RECENT_DAYS is green, one ms older is not; COLD_DAYS is ice, one ms newer is not', () => {
  assert.equal(status(new Date(NOW - 90 * DAY_MS).toISOString(), null), 'green');
  assert.equal(status(new Date(NOW - 90 * DAY_MS - 1).toISOString(), null), 'red');
  assert.equal(status(new Date(NOW - 365 * DAY_MS).toISOString(), null), 'ice');
  assert.equal(status(new Date(NOW - 365 * DAY_MS + 1).toISOString(), null), 'red');
});
test('RECENT_DAYS and COLD_DAYS are configurable', () => {
  assert.equal(status(ago(45), null, { recentDays: 30 }), 'red');
  assert.equal(status(ago(45), null, { recentDays: 60 }), 'green');
  assert.equal(status(ago(200), null, { coldDays: 180 }), 'ice');
});
test('invalid or future dates do not crash', () => {
  assert.equal(status('not a date', undefined), 'grey');
  assert.equal(status(new Date(NOW + DAY_MS).toISOString(), null), 'green');
});
test('toTime handles ISO strings and epoch-ms strings', () => {
  assert.equal(toTime('2026-06-01T12:00:00Z'), NOW);
  assert.equal(toTime(String(NOW)), NOW);
  assert.equal(toTime(''), null);
});
test('latestDate picks the most recent across sources and ignores blanks', () => {
  assert.equal(latestDate(ago(50), String(NOW - 5 * DAY_MS), null, undefined), new Date(NOW - 5 * DAY_MS).toISOString());
  assert.equal(latestDate(null, ''), null);
});
