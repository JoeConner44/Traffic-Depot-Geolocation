const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStatus, latestDate, toTime, DAY_MS } = require('../src/status');

const NOW = Date.parse('2025-06-01T12:00:00Z');
const ago = (d) => new Date(NOW - d * DAY_MS).toISOString();
const status = (p, c, recentDays = 90) => computeStatus({ lastPurchase: p, lastContacted: c }, { now: NOW, recentDays });

test('green: recent purchase wins, whatever the contact date', () => {
  assert.equal(status(ago(10), null), 'green');
  assert.equal(status(ago(10), ago(400)), 'green');
});
test('yellow: no recent purchase but recently contacted', () => {
  assert.equal(status(null, ago(30)), 'yellow');
  assert.equal(status(ago(200), ago(30)), 'yellow');
});
test('red: neither is recent, or both missing', () => {
  assert.equal(status(null, null), 'red');
  assert.equal(status(ago(200), ago(200)), 'red');
});
test('boundary: exactly RECENT_DAYS ago is recent, one ms older is not', () => {
  assert.equal(status(new Date(NOW - 90 * DAY_MS).toISOString(), null), 'green');
  assert.equal(status(new Date(NOW - 90 * DAY_MS - 1).toISOString(), null), 'red');
});
test('RECENT_DAYS is configurable', () => {
  assert.equal(status(ago(45), null, 30), 'red');
  assert.equal(status(ago(45), null, 60), 'green');
});
test('invalid or future dates do not crash', () => {
  assert.equal(status('not a date', undefined), 'red');
  assert.equal(status(new Date(NOW + DAY_MS).toISOString(), null), 'green');
});
test('toTime handles ISO strings and epoch-ms strings', () => {
  assert.equal(toTime('2025-06-01T12:00:00Z'), NOW);
  assert.equal(toTime(String(NOW)), NOW);
  assert.equal(toTime(''), null);
});
test('latestDate picks the most recent across sources and ignores blanks', () => {
  assert.equal(latestDate(ago(50), String(NOW - 5 * DAY_MS), null, undefined), new Date(NOW - 5 * DAY_MS).toISOString());
  assert.equal(latestDate(null, ''), null);
});
