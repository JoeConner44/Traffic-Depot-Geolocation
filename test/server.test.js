const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server');
const { DAY_MS } = require('../src/status');

const cfg = { appPassword: 'pw', sessionSecret: 's3cret', recentDays: 90, coldDays: 365, hubspotPortalId: '123', trustProxy: '0', production: false };
const NOW = Date.now();
const ago = (d) => new Date(NOW - d * DAY_MS).toISOString();

function seed(db) {
  const co = db.prepare("INSERT INTO companies (id,name,city,state,last_purchase,last_contacted,lat,lng,updated_at) VALUES (?,?,?,?,?,?,?,?,'x')");
  co.run('c1', 'Cold Co', 'Rome', 'GA', ago(500), ago(5), 34.25, -85.16);
  co.run('c2', 'Never Co', 'Macon', 'georgia', null, ago(5), 32.84, -83.63);
  co.run('c3', 'Hot Co', 'Atlanta', 'GA', ago(10), ago(10), 33.75, -84.39);
  const ct = db.prepare("INSERT INTO contacts (id,firstname,lastname,email,company_id,last_purchase,last_contacted,lat,lng,unmapped_reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'x')");
  ct.run('p1', 'Pat', 'One', 'secret1@example.com', 'c1', ago(500), ago(5), null, null, null);
  ct.run('p2', 'Quinn', 'Two', 'secret2@example.com', 'c1', ago(700), null, null, null, null);
  ct.run('i1', '', '', 'only-email@example.com', null, null, null, null, null, 'No address, city or ZIP on the contact');
}

async function withServer(fn) {
  const db = openDb(':memory:');
  seed(db);
  const server = createApp({ db, cfg }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); db.close(); }
}

test('API requires a session, then returns companies with their people and the new statuses', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + '/api/contacts')).status, 401);
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=pw' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const res = await fetch(base + '/api/contacts', { headers: { cookie } });
    const text = await res.text();
    const data = JSON.parse(text);

    const by = Object.fromEntries(data.mapped.map((m) => [m.id, m]));
    assert.equal(by.c1.status, 'ice');
    assert.equal(by.c2.status, 'grey');
    assert.equal(by.c3.status, 'green');
    assert.equal(by.c2.state, 'GA');                       // "georgia" normalized
    assert.equal(by.c1.kind, 'company');
    assert.deepEqual(by.c1.people.map((p) => p.name).sort(), ['Pat One', 'Quinn Two']);
    assert.equal(by.c1.people.length, 2);
    assert.equal(by.c1.hubspotUrl, 'https://app.hubspot.com/contacts/123/record/0-2/c1');
    assert.equal(by.c1.people[0].hubspotUrl.includes('/record/0-1/'), true);
    assert.deepEqual(data.counts, { green: 1, yellow: 0, red: 0, ice: 1, grey: 1, unmapped: 1 });
    assert.equal(data.unmapped[0].name, '(no name)');
    assert.equal(data.coldDays, 365);
    assert.doesNotMatch(text, /@example\.com/);            // emails never reach the browser
  });
});
