const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { runSync } = require('../src/sync');
const { createGeocoder } = require('../src/geocode');
const { createHubspotDealsProvider } = require('../src/providers/hubspotDeals');

const contact = (id, props, assoc = {}) => ({ id, properties: props, associations: assoc });

function fakeHubspot(extra) {
  return {
    fetchAllContacts: async () => [
      contact('1', { firstname: 'Ann', lastname: 'A', address: '1 Main St', city: 'Atlanta', state: 'GA', zip: '30303', notes_last_contacted: '2020-01-01T00:00:00Z' }, { deals: { results: [{ id: 'd1' }] } }),
      contact('2', { firstname: 'Bob', lastname: 'B', company: 'Acme', state: '' }, { companies: { results: [{ id: 'c1' }] } }),
      contact('3', { firstname: 'Cy', lastname: 'C', city: 'Miami', state: 'FL' }),
      contact('4', { firstname: 'Di', lastname: 'D' }),
      contact('5', { firstname: 'Ed', lastname: 'E', address: 'nowhere', city: 'Zzz', state: 'GA' }),
      ...(extra || []),
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
    const q = new URL(url).searchParams;
    const addr = q.get('address');
    const restricted = /administrative_area:GA/.test(q.get('components') || '');
    let json;
    if (addr.includes('zzz')) json = { status: 'ZERO_RESULTS', results: [] };
    else {
      // "auburn" resolves to Alabama unless Google is told to stay in GA; "miami" is always Florida.
      const inAL = addr.includes('auburn') && !restricted;
      const loc = addr.includes('miami') ? { lat: 25.76, lng: -80.19, st: 'FL' }
        : inAL ? { lat: 32.6, lng: -85.48, st: 'AL' }
        : addr.includes('rome') ? { lat: 34.25, lng: -85.16, st: 'GA' }
        : { lat: 33.75, lng: -84.39, st: 'GA' };
      json = { status: 'OK', results: [{ formatted_address: addr, geometry: { location: { lat: loc.lat, lng: loc.lng } },
        address_components: [{ short_name: loc.st, types: ['administrative_area_level_1', 'political'] }] }] };
    }
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => json };
  };
  return { fetchImpl, calls };
}

const cfg = { allowNonGA: false, includeEmailSendDate: false };

async function run(db, google, { config = cfg, extra } = {}) {
  const hubspot = fakeHubspot(extra);
  const geocoder = createGeocoder({ db, apiKey: 'k', fetchImpl: google.fetchImpl, sleep: async () => {}, throttleMs: 0 });
  return runSync({ db, config, hubspot, provider: createHubspotDealsProvider({ hubspot }), geocoder, log: () => {} });
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

test('with ALLOW_NON_GA, a GA-labelled contact that geocodes to another state is unmapped; a FL contact stays mapped', async () => {
  const db = openDb(':memory:');
  const extra = [
    contact('6', { firstname: 'Fay', lastname: 'F', address: '1 Bay St', city: 'Miami', state: 'GA', zip: '33101' }),
    contact('7', { firstname: 'Gus', lastname: 'G', address: '2 Bay St', city: 'Miami', state: 'FL', zip: '33101' }),
  ];
  await run(db, fakeGoogle(), { config: { ...cfg, allowNonGA: true }, extra });
  const row = (id) => db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
  assert.equal(row('6').lat, null);
  assert.match(row('6').unmapped_reason, /says GA but geocoded to FL/);
  assert.equal(row('7').lat, 25.76);
});

test('Georgia contacts are geocoded with a GA restriction, so Auburn, GA does not land in Auburn, AL', async () => {
  const db = openDb(':memory:');
  const google = fakeGoogle();
  const extra = [contact('8', { firstname: 'Hal', lastname: 'H', city: 'Auburn', state: 'GA' })];
  await run(db, google, { extra });
  assert.ok(google.calls.some((u) => /auburn/.test(u) && /administrative_area%3AGA|administrative_area:GA/.test(decodeURIComponent(u))));
  const r = db.prepare('SELECT * FROM contacts WHERE id=?').get('8');
  assert.equal(r.lat, 33.75); // Georgia, not Alabama's 32.6
});

test('legacy cache rows (no geo_state) are looked up again once, then served from cache', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO geocode_cache (address_key, lat, lng, status, created_at) VALUES ('auburn, ga', 32.6, -85.48, 'ok', ?)").run(new Date().toISOString());
  const google = fakeGoogle();
  const extra = [contact('8', { firstname: 'Hal', lastname: 'H', city: 'Auburn', state: 'GA' })];
  await run(db, google, { extra });
  assert.equal(db.prepare('SELECT lat FROM contacts WHERE id=?').get('8').lat, 33.75);
  const before = google.calls.length;
  await run(db, google, { extra });
  assert.equal(google.calls.length, before);
});
