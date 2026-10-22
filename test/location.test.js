const test = require('node:test');
const assert = require('node:assert/strict');
const { passesStateFilter, normalizeAddress, resolveLocation, inGeorgia } = require('../src/location');

test('state filter: GA, Georgia, blank pass; others skipped unless allowed', () => {
  for (const s of ['GA', 'ga', 'Georgia', ' G.A. ', '', undefined]) assert.equal(passesStateFilter(s, false), true, String(s));
  assert.equal(passesStateFilter('FL', false), false);
  assert.equal(passesStateFilter('FL', true), true);
});
test('normalizeAddress is stable across case/punctuation and defaults blank state to GA', () => {
  const a = normalizeAddress({ address: '123 Main St.', city: 'Atlanta', state: 'Georgia', zip: '30303-1234' });
  const b = normalizeAddress({ address: '123  MAIN ST', city: 'atlanta', state: 'ga', zip: '30303' });
  assert.equal(a, '123 main st, atlanta, ga 30303');
  assert.equal(a, b);
  assert.equal(normalizeAddress({ city: 'Macon' }), 'macon, ga');
});
test('normalizeAddress returns null when there is nothing to geocode', () => {
  assert.equal(normalizeAddress({ state: 'GA' }), null);
  assert.equal(normalizeAddress({}), null);
});
test('company address fallback is used and flagged only when the contact has none', () => {
  const companies = new Map([['9', { properties: { name: 'Acme', address: '1 Plant Rd', city: 'Rome', state: 'GA', zip: '30161' } }]]);
  const own = resolveLocation({ address: '5 A St', city: 'Dalton', companyIds: ['9'] }, companies);
  assert.equal(own.source, 'contact');
  const fb = resolveLocation({ address: '', city: '', companyIds: ['9'] }, companies);
  assert.equal(fb.source, 'company');
  assert.equal(fb.city, 'Rome');
  assert.equal(resolveLocation({ companyIds: ['404'] }, companies).source, null);
});
test('inGeorgia bounding box', () => {
  assert.equal(inGeorgia(33.749, -84.388), true);
  assert.equal(inGeorgia(25.76, -80.19), false); // Miami
});
