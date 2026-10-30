const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { runSync } = require('../src/sync');
const { createGeocoder } = require('../src/geocode');
const { createHubspotDealsProvider } = require('../src/providers/hubspotDeals');
const { shapeContact } = require('../src/hubspot');

const link = (id) => ({ id, type: 'contact_to_company' });
const contact = (id, props, assoc = {}) => ({ id, properties: props, associations: assoc });
const inCompany = (cid, extra = {}) => ({ companies: { results: [link(cid)] }, ...extra });

const BASE = [
  contact('1', { firstname: 'Ann', lastname: 'A', address: '1 Main St', city: 'Atlanta', state: 'GA', zip: '30303', notes_last_contacted: '2020-01-01T00:00:00Z' }, { deals: { results: [{ id: 'd1' }] } }),
  contact('2', { firstname: 'Bob', lastname: 'B', company: 'Acme', state: '' }, inCompany('c1')),
  contact('3', { firstname: 'Cy', lastname: 'C', city: 'Miami', state: 'FL' }),
  contact('4', { firstname: 'Di', lastname: 'D' }),
  contact('5', { firstname: 'Ed', lastname: 'E', address: 'nowhere', city: 'Zzz', state: 'GA' }),
  contact('6', { firstname: 'Eve', lastname: 'E' }, inCompany('c2')),
  contact('7', { firstname: 'Flo', lastname: 'F', notes_last_contacted: '2026-05-01T00:00:00Z' }, inCompany('c1')),
];
const COMPANIES = {
  c1: { name: 'Acme', address: '9 Plant Rd', city: 'Rome', state: 'GA', zip: '30161' },
  c2: { name: 'Ghost Co' },
  c3: { name: 'Beach Co', address: '5 Ocean Dr', city: 'Miami', state: 'FL', zip: '33101' },
  c4: { name: 'No Address Co' },
  c5: { name: 'Deal Only Co', address: '7 Mill St', city: 'Macon', state: 'GA', zip: '31201' },
};

function fakeHubspot(extra = [], companyDeals = { c1: ['d2'], c5: ['d5'] }) {
  return {
    fetchAllContacts: async () => [...BASE, ...extra],
    fetchCompanies: async (ids) => ids.filter((id) => COMPANIES[id]).map((id) => ({ id, properties: COMPANIES[id] })),
    fetchCompanyDealIds: async (ids) => new Map(ids.map((id) => [id, companyDeals[id] || []])),
    fetchDeals: async (ids) => ids.map((id) => ({ id, properties: { pipeline: 'default', dealstage: 'won', closedate: id === 'd2' ? '2026-02-01T00:00:00Z' : '2025-05-01T00:00:00Z' } })),
    fetchClosedWonStages: async () => new Set(['default:won']),
    // d5 is a won deal on a company that has no contacts; d6 is not won.
    fetchAllDeals: async () => [
      { id: 'd5', properties: { pipeline: 'default', dealstage: 'won' }, associations: { companies: { results: [{ id: 'c5' }] } } },
      { id: 'd6', properties: { pipeline: 'default', dealstage: 'open' }, associations: { companies: { results: [{ id: 'c4' }] } } },
    ],
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

async function run(db, google, { config = cfg, extra, companyDeals } = {}) {
  const hubspot = fakeHubspot(extra, companyDeals);
  const geocoder = createGeocoder({ db, apiKey: 'k', fetchImpl: google.fetchImpl, sleep: async () => {}, throttleMs: 0 });
  return runSync({ db, config, hubspot, provider: createHubspotDealsProvider({ hubspot }), geocoder, log: () => {} });
}
const contactRow = (db, id) => db.prepare('SELECT * FROM contacts WHERE id=?').get(id);
const companyRow = (db, id) => db.prepare('SELECT * FROM companies WHERE id=?').get(id);

test('people are grouped under their company, which is placed and aggregated; individuals map themselves', async () => {
  const db = openDb(':memory:');
  const s = await run(db, fakeGoogle());
  assert.equal(s.fetched, 7);
  assert.equal(s.skippedNonGA, 1);                       // Cy (FL)
  assert.equal(s.companies, 3);                          // Acme, Ghost Co, and Deal Only Co (won deal, no contacts)
  assert.equal(s.companiesWithoutPeople, 1);
  assert.equal(s.companiesMapped, 2);                    // Acme, Deal Only Co
  assert.equal(s.companiesUnmapped, 1);                  // Ghost Co has no address anywhere
  assert.equal(s.individuals, 3);                        // Ann, Di, Ed
  assert.equal(s.individualsMapped, 1);
  assert.equal(s.people, 3);                             // Bob, Flo, Eve

  const acme = companyRow(db, 'c1');
  assert.equal(acme.name, 'Acme');
  assert.equal(acme.city, 'Rome');
  assert.equal(acme.lat, 34.25);
  assert.equal(acme.location_source, 'company');
  assert.equal(acme.last_purchase, '2026-02-01T00:00:00.000Z');   // from the deal attached to the company itself
  assert.equal(acme.last_contacted, '2026-05-01T00:00:00.000Z');  // latest across its people
  assert.match(companyRow(db, 'c2').unmapped_reason, /No address/);
  const dealOnly = companyRow(db, 'c5');                   // a customer with a won deal but no contacts is still on the map
  assert.equal(dealOnly.name, 'Deal Only Co');
  assert.equal(dealOnly.lat != null, true);
  assert.equal(dealOnly.last_purchase, '2025-05-01T00:00:00.000Z');
  assert.equal(companyRow(db, 'c4'), undefined);           // open deal only: not a purchase, no people -> not created

  assert.equal(contactRow(db, '2').company_id, 'c1');
  assert.equal(contactRow(db, '2').lat, null);            // shown inside the company, not on its own
  assert.equal(contactRow(db, '2').unmapped_reason, null);
  assert.equal(contactRow(db, '1').company_id, null);
  assert.equal(contactRow(db, '1').last_purchase, '2025-05-01T00:00:00.000Z');
  assert.match(contactRow(db, '4').unmapped_reason, /No address/);
  assert.match(contactRow(db, '5').unmapped_reason, /could not be geocoded/);
  assert.equal(contactRow(db, '3'), undefined);
});

test('sync is idempotent and geocodes each address only once', async () => {
  const db = openDb(':memory:');
  const google = fakeGoogle();
  await run(db, google);
  const first = google.calls.length;
  assert.equal(first, 4);                                  // Atlanta, Rome, Macon, "nowhere" (not found)
  const again = await run(db, google);
  assert.equal(google.calls.length, first);
  assert.equal(again.geocodeApiCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n, 6);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n, 3);
});

test('a company with no address of its own is placed at a person\'s address and flagged', async () => {
  const db = openDb(':memory:');
  const extra = [contact('8', { firstname: 'Gil', lastname: 'G', address: '3 Mill Rd', city: 'Rome', state: 'GA' }, inCompany('c4'))];
  await run(db, fakeGoogle(), { extra });
  const co = companyRow(db, 'c4');
  assert.equal(co.location_source, 'contact');
  assert.equal(co.lat, 34.25);
});

test('a company whose address is outside Georgia is skipped together with its people', async () => {
  const db = openDb(':memory:');
  const extra = [contact('9', { firstname: 'Hal', lastname: 'H' }, inCompany('c3'))];
  const s = await run(db, fakeGoogle(), { extra });
  assert.equal(companyRow(db, 'c3'), undefined);
  assert.equal(contactRow(db, '9'), undefined);
  assert.equal(s.skippedNonGA, 2);
});

test('with ALLOW_NON_GA, a GA-labelled contact that geocodes to another state is unmapped; a FL contact stays mapped', async () => {
  const db = openDb(':memory:');
  const extra = [
    contact('10', { firstname: 'Fay', lastname: 'F', address: '1 Bay St', city: 'Miami', state: 'GA', zip: '33101' }),
    contact('11', { firstname: 'Gus', lastname: 'G', address: '2 Bay St', city: 'Miami', state: 'FL', zip: '33101' }),
  ];
  await run(db, fakeGoogle(), { config: { ...cfg, allowNonGA: true }, extra });
  assert.equal(contactRow(db, '10').lat, null);
  assert.match(contactRow(db, '10').unmapped_reason, /says GA but geocoded to FL/);
  assert.equal(contactRow(db, '11').lat, 25.76);
});

test('Georgia contacts are geocoded with a GA restriction, so Auburn, GA does not land in Auburn, AL', async () => {
  const db = openDb(':memory:');
  const google = fakeGoogle();
  const extra = [contact('12', { firstname: 'Hal', lastname: 'H', city: 'Auburn', state: 'GA' })];
  await run(db, google, { extra });
  assert.ok(google.calls.some((u) => /auburn/.test(u) && /administrative_area:GA/.test(decodeURIComponent(u))));
  assert.equal(contactRow(db, '12').lat, 33.75);           // Georgia, not Alabama's 32.6
});

test('legacy cache rows (no geo_state) are looked up again once, then served from cache', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO geocode_cache (address_key, lat, lng, status, created_at) VALUES ('auburn, ga', 32.6, -85.48, 'ok', ?)").run(new Date().toISOString());
  const google = fakeGoogle();
  const extra = [contact('12', { firstname: 'Hal', lastname: 'H', city: 'Auburn', state: 'GA' })];
  await run(db, google, { extra });
  assert.equal(contactRow(db, '12').lat, 33.75);
  const before = google.calls.length;
  await run(db, google, { extra });
  assert.equal(google.calls.length, before);
});

test('shapeContact still works on the shapes the sync relies on', () => {
  assert.equal(shapeContact(BASE[1]).primaryCompanyId, 'c1');
});
