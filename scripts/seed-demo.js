// Loads ~200 fake Georgia contacts so the map can be demoed without HubSpot/Google credentials.
// Replaces any previous demo rows; real contacts (non-"demo-" ids) are left alone.
const { openDb } = require('../src/db');
const { DAY_MS } = require('../src/status');

const CITIES = [
  ['Atlanta', 33.749, -84.388, 36], ['Savannah', 32.0809, -81.0912, 14], ['Augusta', 33.4735, -82.0105, 12],
  ['Columbus', 32.4609, -84.9877, 12], ['Macon', 32.8407, -83.6324, 12], ['Athens', 33.9519, -83.3576, 10],
  ['Albany', 31.5785, -84.1557, 8], ['Valdosta', 30.8327, -83.2785, 8], ['Roswell', 34.0232, -84.3616, 8],
  ['Marietta', 33.9526, -84.5499, 10], ['Gainesville', 34.2979, -83.8241, 7], ['Rome', 34.2570, -85.1647, 6],
  ['Dalton', 34.7698, -84.9702, 6], ['Warner Robins', 32.6130, -83.6242, 7], ['Brunswick', 31.1499, -81.4915, 5],
  ['Statesboro', 32.4488, -81.7832, 5], ['Douglas', 31.5088, -82.8499, 4], ['Tifton', 31.4505, -83.5085, 4],
  ['Carrollton', 33.5801, -85.0766, 5], ['Peachtree City', 33.3968, -84.5955, 6], ['Duluth', 33.9829, -84.1446, 6],
];
const FIRST = ['James','Maria','Robert','Linda','Michael','Patricia','David','Jennifer','William','Elizabeth','Marcus','Tasha','Carlos','Aisha','Derek','Priya','Kevin','Latoya','Brian','Nicole'];
const LAST = ['Johnson','Williams','Brown','Davis','Miller','Wilson','Moore','Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Garcia','Martinez','Robinson','Clark','Lewis'];
const BIZ = ['Paving','Signs & Safety','Construction','Electric','Barricade Rentals','Landscaping','Utilities','Contracting','Highway Supply','Excavating'];
const STREETS = ['Peachtree St','Main St','Oak Ave','Industrial Blvd','Cherokee Dr','Magnolia Ln','Church St','Lakeview Rd'];

// Small deterministic PRNG so the demo looks the same every run.
let seed = 20240607;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

function main() {
  const db = openDb();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const daysAgo = (d) => new Date(now - d * DAY_MS).toISOString();
  const insert = db.prepare(`
    INSERT INTO contacts (id, firstname, lastname, email, company, address, city, state, zip, location_source,
      last_contacted, last_purchase, lat, lng, unmapped_reason, updated_at)
    VALUES (@id, @firstname, @lastname, @email, @company, @address, @city, @state, @zip, @location_source,
      @last_contacted, @last_purchase, @lat, @lng, @unmapped_reason, @updated_at)`);

  const rows = [];
  let n = 0;
  for (const [city, lat, lng, count] of CITIES) {
    for (let i = 0; i < count; i++) {
      n++;
      const first = pick(FIRST), last = pick(LAST);
      const roll = rnd();
      // ~30% bought recently, ~25% contacted only, rest stale
      let lastPurchase = null, lastContacted = null;
      if (roll < 0.30) { lastPurchase = daysAgo(Math.floor(rnd() * 85)); lastContacted = daysAgo(Math.floor(rnd() * 120)); }
      else if (roll < 0.55) { lastPurchase = rnd() < 0.6 ? daysAgo(95 + Math.floor(rnd() * 600)) : null; lastContacted = daysAgo(Math.floor(rnd() * 85)); }
      else { lastPurchase = rnd() < 0.5 ? daysAgo(100 + Math.floor(rnd() * 900)) : null; lastContacted = rnd() < 0.7 ? daysAgo(95 + Math.floor(rnd() * 500)) : null; }
      rows.push({
        id: `demo-${n}`, firstname: first, lastname: last,
        email: `${first}.${last}${n}@example.com`.toLowerCase(),
        company: `${last} ${pick(BIZ)}`,
        address: `${100 + Math.floor(rnd() * 8900)} ${pick(STREETS)}`, city, state: 'GA',
        zip: String(30000 + Math.floor(rnd() * 1999)),
        location_source: rnd() < 0.08 ? 'company' : 'contact',
        last_contacted: lastContacted, last_purchase: lastPurchase,
        lat: lat + (rnd() - 0.5) * 0.14, lng: lng + (rnd() - 0.5) * 0.18,
        unmapped_reason: null, updated_at: nowIso,
      });
    }
  }
  // A handful that can't be placed, to show the sidebar panel.
  const reasons = ['No address, city or ZIP on the contact or its company', 'Address could not be geocoded (12 nowhere rd, ga)', 'Geocoded outside Georgia (123 main st, ga)'];
  for (let i = 0; i < 9; i++) {
    n++;
    const first = pick(FIRST), last = pick(LAST);
    rows.push({
      id: `demo-${n}`, firstname: first, lastname: last, email: `${first}.${last}${n}@example.com`.toLowerCase(),
      company: `${last} ${pick(BIZ)}`, address: '', city: '', state: '', zip: '', location_source: null,
      last_contacted: rnd() < 0.5 ? daysAgo(Math.floor(rnd() * 200)) : null, last_purchase: rnd() < 0.3 ? daysAgo(Math.floor(rnd() * 400)) : null,
      lat: null, lng: null, unmapped_reason: reasons[i % reasons.length], updated_at: nowIso,
    });
  }

  db.transaction(() => {
    db.prepare("DELETE FROM contacts WHERE id LIKE 'demo-%'").run();
    for (const r of rows) insert.run(r);
    db.prepare('INSERT INTO sync_runs (started_at, finished_at, ok, summary) VALUES (?, ?, 1, ?)')
      .run(nowIso, nowIso, JSON.stringify({ demo: true, contacts: rows.length }));
  })();
  console.log(`Seeded ${rows.length} demo contacts (${rows.filter((r) => r.lat == null).length} unmapped) into ${db.name}`);
  db.close();
}

main();
