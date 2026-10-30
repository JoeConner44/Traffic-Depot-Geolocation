// Loads fake Georgia data so the map can be demoed without HubSpot/Google credentials:
// ~70 companies (1-4 people each) plus a few individuals, with every status represented.
// Replaces any previous demo rows; real data (non-"demo-" ids) is left alone.
const { openDb } = require('../src/db');
const { DAY_MS, latestDate } = require('../src/status');

const CITIES = [
  ['Atlanta', 33.749, -84.388, 12], ['Savannah', 32.0809, -81.0912, 5], ['Augusta', 33.4735, -82.0105, 5],
  ['Columbus', 32.4609, -84.9877, 5], ['Macon', 32.8407, -83.6324, 5], ['Athens', 33.9519, -83.3576, 4],
  ['Albany', 31.5785, -84.1557, 3], ['Valdosta', 30.8327, -83.2785, 3], ['Roswell', 34.0232, -84.3616, 3],
  ['Marietta', 33.9526, -84.5499, 4], ['Gainesville', 34.2979, -83.8241, 3], ['Rome', 34.2570, -85.1647, 2],
  ['Dalton', 34.7698, -84.9702, 2], ['Warner Robins', 32.6130, -83.6242, 3], ['Brunswick', 31.1499, -81.4915, 2],
  ['Statesboro', 32.4488, -81.7832, 2], ['Tifton', 31.4505, -83.5085, 2], ['Peachtree City', 33.3968, -84.5955, 2],
];
const FIRST = ['James','Maria','Robert','Linda','Michael','Patricia','David','Jennifer','William','Elizabeth','Marcus','Tasha','Carlos','Aisha','Derek','Priya','Kevin','Latoya','Brian','Nicole'];
const LAST = ['Johnson','Williams','Brown','Davis','Miller','Wilson','Moore','Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Garcia','Martinez','Robinson','Clark','Lewis'];
const BIZ = ['Paving','Signs & Safety','Construction','Electric','Barricade Rentals','Landscaping','Utilities','Contracting','Highway Supply','Excavating'];

// Small deterministic PRNG so the demo looks the same every run.
let seed = 20240607;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

function main() {
  const db = openDb();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const daysAgo = (d) => new Date(now - d * DAY_MS).toISOString();

  // Purchase history for one person: green / bought-before (yellow or red) / gone cold (ice) / never (grey).
  const history = () => {
    const r = rnd();
    let lastPurchase = null;
    if (r < 0.18) lastPurchase = daysAgo(Math.floor(rnd() * 85));
    else if (r < 0.38) lastPurchase = daysAgo(95 + Math.floor(rnd() * 265));
    else if (r < 0.60) lastPurchase = daysAgo(370 + Math.floor(rnd() * 700));
    const lastContacted = rnd() < 0.55 ? daysAgo(Math.floor(rnd() * 80)) : (rnd() < 0.7 ? daysAgo(95 + Math.floor(rnd() * 500)) : null);
    return { last_purchase: lastPurchase, last_contacted: lastContacted };
  };

  const companies = [], people = [];
  let n = 0, c = 0;
  const newPerson = (companyId, company) => {
    n++;
    const first = pick(FIRST), last = pick(LAST);
    return { id: `demo-${n}`, firstname: first, lastname: last, email: `${first}.${last}${n}@example.com`.toLowerCase(),
      company, address: '', city: '', state: 'GA', zip: '', company_id: companyId, location_source: null,
      ...history(), lat: null, lng: null, unmapped_reason: null, updated_at: nowIso };
  };

  for (const [city, lat, lng, count] of CITIES) {
    for (let i = 0; i < count; i++) {
      c++;
      const name = `${pick(LAST)} ${pick(BIZ)}`;
      const id = `demo-c${c}`;
      const staff = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => newPerson(id, name));
      staff.forEach((p) => { p.city = city; });
      people.push(...staff);
      companies.push({
        id, name, address: `${100 + Math.floor(rnd() * 8900)} Industrial Blvd`, city, state: 'GA',
        zip: String(30000 + Math.floor(rnd() * 1999)), location_source: 'company',
        last_contacted: latestDate(...staff.map((p) => p.last_contacted)),
        last_purchase: latestDate(...staff.map((p) => p.last_purchase)),
        lat: lat + (rnd() - 0.5) * 0.14, lng: lng + (rnd() - 0.5) * 0.18, unmapped_reason: null, updated_at: nowIso,
      });
    }
  }
  // Individuals with no company (mapped), then some that can't be placed.
  for (let i = 0; i < 8; i++) {
    const [city, lat, lng] = pick(CITIES);
    const p = newPerson(null, '');
    Object.assign(p, { company: `${p.lastname} ${pick(BIZ)}`, city, location_source: 'contact',
      lat: lat + (rnd() - 0.5) * 0.14, lng: lng + (rnd() - 0.5) * 0.18 });
    people.push(p);
  }
  for (let i = 0; i < 3; i++) {
    c++;
    const name = `${pick(LAST)} ${pick(BIZ)}`, id = `demo-c${c}`;
    const staff = [newPerson(id, name), newPerson(id, name)];
    people.push(...staff);
    companies.push({ id, name, address: '', city: '', state: '', zip: '', location_source: null,
      last_contacted: latestDate(...staff.map((p) => p.last_contacted)), last_purchase: latestDate(...staff.map((p) => p.last_purchase)),
      lat: null, lng: null, unmapped_reason: 'No address, city or ZIP on the company or any of its people', updated_at: nowIso });
  }
  for (let i = 0; i < 4; i++) {
    const p = newPerson(null, `${pick(LAST)} ${pick(BIZ)}`);
    Object.assign(p, { state: '', location_source: 'contact', unmapped_reason: i % 2 ? 'Address could not be geocoded (12 nowhere rd, ga)' : 'No address, city or ZIP on the contact' });
    people.push(p);
  }

  const insContact = db.prepare(`
    INSERT INTO contacts (id, firstname, lastname, email, company, address, city, state, zip, company_id, location_source,
      last_contacted, last_purchase, lat, lng, unmapped_reason, updated_at)
    VALUES (@id, @firstname, @lastname, @email, @company, @address, @city, @state, @zip, @company_id, @location_source,
      @last_contacted, @last_purchase, @lat, @lng, @unmapped_reason, @updated_at)`);
  const insCompany = db.prepare(`
    INSERT INTO companies (id, name, address, city, state, zip, location_source, last_contacted, last_purchase,
      lat, lng, unmapped_reason, updated_at)
    VALUES (@id, @name, @address, @city, @state, @zip, @location_source, @last_contacted, @last_purchase,
      @lat, @lng, @unmapped_reason, @updated_at)`);
  db.transaction(() => {
    db.prepare("DELETE FROM contacts WHERE id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM companies WHERE id LIKE 'demo-%'").run();
    companies.forEach((r) => insCompany.run(r));
    people.forEach((r) => insContact.run(r));
    db.prepare('INSERT INTO sync_runs (started_at, finished_at, ok, summary) VALUES (?, ?, 1, ?)')
      .run(nowIso, nowIso, JSON.stringify({ demo: true, companies: companies.length, people: people.length }));
  })();
  console.log(`Seeded ${companies.length} companies and ${people.length} people into ${db.name}`);
  db.close();
}

main();
