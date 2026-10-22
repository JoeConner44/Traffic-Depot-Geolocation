const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { runSync } = require('../src/sync');
const { createGeocoder } = require('../src/geocode');
const { createHubspotDealsProvider } = require('../src/providers/hubspotDeals');

const contact = (id, props, assoc = {}) => ({ id, properties: props, associations: assoc });

function fakeHubspot() {
  return {
    fetchAllContacts: async () => [
      contact('1', { firstname: 'Ann', lastname: 'A', address: '1 Main St', city: 'Atlanta', state: 'GA', zip: '30303', notes_last_contacted: '2020-01-01T00:00:00Z' }, { deals: { results: [{ id: 'd1' }] } }),
      contact('2', { firstname: 'Bob', lastname: 'B', company: 'Acme', state: '' }, { companies: { results: [{ id: 'c1' }] } }),
      contact('3', { firstname: 'Cy', lastname: 'C', city: 'Miami', state: 'FL' }),
      contact('4', { firstname: 'Di', lastname: 'D' }),
      contact('5', { firstname: 'Ed', lastname: 'E', address: 'nowhere', city: 'Zzz', state: 'GA' }),
    ],
    fetchCompanies: async () => [{ id: 'c1', properties: { name: 'Acme', address: '9 Plant Rd', city: 'Rome', state: 'GA', zip: '30161' } }],
    fetchDeals: async () => [{ id: 'd1', properties: { pipeline: 'default', dealstage: 'won', closedate: '2025-05-01T00:00:00Z' } }],
    fetchClosedWonStages: async () => new Set(['default:won']),
  };
}

function fakeGoogle() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const addr = new URL(url).searchParams.get('address');
    const json = addr.includes('zzz')
      ? { status: 'ZERO_RESULTS', results: [] }
      : { status: 'OK', results: [{ formatted_address: addr, geometry: { location: addr.includes('rome') ? { lat: 34.25, lng: -85.16 } : { lat: 33.75, lng: -84.39 } } }] };
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => json };
  };
  return { fetchImpl, calls };
}

const cfg = { allowNonGA: false, includeEmailSendDate: false };

async function run(db, google) {
  const hubspot = fakeHubspot();
  const geocoder = createGeocoder({ db, apiKey: 'k', fetchImpl: google.fetchImpl, sleep: async () => {}, throttleMs: 0 });
  return runSync({ db, config: cfg, hubspot, provider: createHubspotDealsProvider({ hubspot }), geocoder, log: () => {} });
}

test('sync maps, falls back to company address, reports unmapped, skips non-GA', async () => {
  const db = openDb(':memory:');
  const summary = await run(db, fakeGoogle());
  assert.equal(summary.fetched, 5);
  assert.equal(summary.skippedNonGA, 1);
  assert.equal(summary.stored, 4);
  assert.equal(summary.mapped, 2);
  assert.equal(summary.unmapped, 2);
  assert.equal(summary.addressFromCompany, 1);
  const row = (id) => db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
  assert.equal(row('1').last_purchase, '2025-05-01T00:00:00.000Z');
  assert.equal(row('2').location_source, 'company');
  assert.equal(row('2').city, 'Rome');
  assert.match(row('4').unmapped_reason, /No address/);
  assert.match(row('5').unmapped_reason, /could not be geocoded/);
  assert.equal(row('3'), undefined);
});

test('sync is idempotent and geocodes each address only once', async () => {
  const db = openDb(':memory:');
  const google = fakeGoogle();
  await run(db, google);
  const firstCalls = google.calls.length;
  assert.equal(firstCalls, 3);
  const again = await run(db, google);
  assert.equal(google.calls.length, firstCalls); // all served from geocode_cache (incl. the not-found one)
  assert.equal(again.geocodeApiCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n, 4);
});
