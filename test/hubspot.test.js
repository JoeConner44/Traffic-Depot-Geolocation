const test = require('node:test');
const assert = require('node:assert/strict');
const { closedWonStagesFromPipelines, createHubSpotClient, shapeContact } = require('../src/hubspot');
const { lastPurchaseFromDeals } = require('../src/providers/hubspotDeals');

const res = (status, body, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });

test('closed-won stages come from pipeline metadata, not hardcoded ids', () => {
  const set = closedWonStagesFromPipelines([{
    id: 'default', stages: [
      { id: 'closedwon', metadata: { isClosed: 'true', probability: '1.0' } },
      { id: 'closedlost', metadata: { isClosed: 'true', probability: '0.0' } },
      { id: 'open', metadata: { isClosed: 'false', probability: '0.5' } },
    ],
  }, { id: 'p2', stages: [{ id: 'custom-won', metadata: { isClosed: 'true', probability: '1.0' } }] }]);
  assert.deepEqual([...set].sort(), ['default:closedwon', 'p2:custom-won']);
});
test('last purchase = most recent close date among closed-won deals only', () => {
  const won = new Set(['default:won']);
  const deals = new Map([
    ['1', { properties: { pipeline: 'default', dealstage: 'won', closedate: '2025-01-10T00:00:00Z' } }],
    ['2', { properties: { pipeline: 'default', dealstage: 'won', closedate: '2025-04-02T00:00:00Z' } }],
    ['3', { properties: { pipeline: 'default', dealstage: 'lost', closedate: '2025-05-30T00:00:00Z' } }],
  ]);
  assert.equal(lastPurchaseFromDeals(['1', '2', '3', '99'], deals, won), '2025-04-02T00:00:00.000Z');
  assert.equal(lastPurchaseFromDeals(['3'], deals, won), null);
});
test('client follows pagination and retries on 429 honoring Retry-After', async () => {
  const calls = [];
  const sleeps = [];
  const queue = [
    res(429, {}, { 'retry-after': '2' }),
    res(200, { results: [{ id: '1', properties: {} }], paging: { next: { after: 'abc' } } }),
    res(200, { results: [{ id: '2', properties: {} }] }),
  ];
  const client = createHubSpotClient({ token: 't', fetchImpl: async (url) => { calls.push(url); return queue.shift(); }, sleep: async (ms) => { sleeps.push(ms); } });
  const all = await client.fetchAllContacts();
  assert.deepEqual(all.map((c) => c.id), ['1', '2']);
  assert.equal(calls.length, 3);
  assert.match(calls[2], /after=abc/);
  assert.deepEqual(sleeps, [2000]);
});
test('shapeContact extracts association ids and picks the primary company', () => {
  const c = shapeContact({ id: 5, properties: { firstname: 'A' }, associations: {
    deals: { results: [{ id: '7' }] },
    companies: { results: [{ id: '8', type: 'contact_to_company_unlabeled' }, { id: '9', type: 'contact_to_company' }] },
  } });
  assert.deepEqual([c.id, c.dealIds, c.companyIds, c.primaryCompanyId], ['5', ['7'], ['8', '9'], '9']);
  assert.equal(shapeContact({ id: 6, properties: {} }).primaryCompanyId, null);
});
test('company-level deals count toward the company purchase date', async () => {
  const { createHubspotDealsProvider } = require('../src/providers/hubspotDeals');
  const hubspot = {
    fetchClosedWonStages: async () => new Set(['default:won']),
    fetchCompanyDealIds: async () => new Map([['c1', ['d9']]]),
    fetchDeals: async (ids) => ids.map((id) => ({ id, properties: { pipeline: 'default', dealstage: 'won', closedate: id === 'd9' ? '2026-03-01T00:00:00Z' : '2025-01-01T00:00:00Z' } })),
  };
  const out = await createHubspotDealsProvider({ hubspot }).getLastPurchases([{ id: '1', dealIds: ['d1'] }], ['c1']);
  assert.equal(out.byContact.get('1'), '2025-01-01T00:00:00.000Z');
  assert.equal(out.byCompany.get('c1'), '2026-03-01T00:00:00.000Z');
});

test('fetchAllDeals follows pagination and requests associations', async () => {
  const urls = [];
  const queue = [
    res(200, { results: [{ id: '1' }], paging: { next: { after: 'x' } } }),
    res(200, { results: [{ id: '2' }] }),
  ];
  const client = createHubSpotClient({ token: 't', fetchImpl: async (u) => { urls.push(u); return queue.shift(); }, sleep: async () => {} });
  const deals = await client.fetchAllDeals();
  assert.deepEqual(deals.map((d) => d.id), ['1', '2']);
  assert.match(urls[0], /associations=contacts%2Ccompanies/);
  assert.match(urls[1], /after=x/);
});
