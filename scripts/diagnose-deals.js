// Counts-only report on HubSpot deals: which stages exist, which count as "closed won", how many deals sit in each,
// when they closed, and whether they are linked to contacts/companies. Prints no customer data.
//   node scripts/diagnose-deals.js
const config = require('../src/config');
const { createHubSpotClient, closedWonStagesFromPipelines } = require('../src/hubspot');
const { openDb } = require('../src/db');

async function main() {
  const hs = createHubSpotClient({ token: config.hubspotToken });
  const pipelines = await hs.fetchDealPipelines();
  const won = closedWonStagesFromPipelines(pipelines);
  const info = new Map();
  for (const p of pipelines) {
    for (const s of p.stages || []) {
      const m = s.metadata || {};
      info.set(`${p.id}:${s.id}`, { pipeline: p.label, stage: s.label, isClosed: String(m.isClosed), probability: String(m.probability) });
    }
  }
  const deals = await hs.fetchAllDeals();
  console.log(`Pipelines: ${pipelines.length} | stages counted as closed-won: ${won.size} | total deals: ${deals.length}\n`);

  const byStage = new Map();
  const years = {};
  const wonCompanies = new Set(), wonContacts = new Set();
  let reachableOnlyViaPerson = 0;
  const wonDealRows = [];
  let wonDeals = 0, wonWithContact = 0, wonWithCompany = 0, wonNoClose = 0, wonNoAssoc = 0, unknownStage = 0;
  for (const d of deals) {
    const p = d.properties || {};
    const key = `${p.pipeline}:${p.dealstage}`;
    const hasContact = !!(d.associations && d.associations.contacts && d.associations.contacts.results.length);
    const hasCompany = !!(d.associations && d.associations.companies && d.associations.companies.results.length);
    const row = byStage.get(key) || { n: 0, min: null, max: null };
    row.n++;
    if (p.closedate) {
      const t = Date.parse(p.closedate);
      if (!Number.isNaN(t)) { row.min = row.min == null ? t : Math.min(row.min, t); row.max = row.max == null ? t : Math.max(row.max, t); }
    }
    byStage.set(key, row);
    if (!info.has(key)) unknownStage++;
    if (won.has(key)) {
      const ids = (k) => ((d.associations && d.associations[k] && d.associations[k].results) || []).map((r) => String(r.id));
      wonDealRows.push({ companies: ids('companies'), contacts: ids('contacts') });
      ids('companies').forEach((c) => wonCompanies.add(c));
      ids('contacts').forEach((c) => wonContacts.add(c));
      wonDeals++;
      if (hasContact) wonWithContact++;
      if (hasCompany) wonWithCompany++;
      if (!hasContact && !hasCompany) wonNoAssoc++;
      if (!p.closedate) wonNoClose++;
      else years[p.closedate.slice(0, 4)] = (years[p.closedate.slice(0, 4)] || 0) + 1;
    }
  }
  const day = (t) => (t == null ? '-' : new Date(t).toISOString().slice(0, 10));
  console.log('Deals by stage (WON = counted as a purchase):');
  [...byStage.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([key, r]) => {
    const i = info.get(key) || { pipeline: '?', stage: `(unknown ${key})`, isClosed: '?', probability: '?' };
    console.log(`  ${won.has(key) ? 'WON ' : '    '} ${String(r.n).padStart(5)}  ${i.pipeline} / ${i.stage}  [isClosed=${i.isClosed} probability=${i.probability}]  closed ${day(r.min)} .. ${day(r.max)}`);
  });
  console.log(`\nClosed-won deals: ${wonDeals}`);
  console.log(`  linked to a contact: ${wonWithContact} | linked to a company: ${wonWithCompany} | linked to neither: ${wonNoAssoc} | missing close date: ${wonNoClose}`);
  console.log('  by year closed:', years);

  // Compare with what the last sync stored.
  const db = openDb();
  const dbCompanies = new Map(db.prepare('SELECT id, last_purchase, lat FROM companies').all().map((r) => [r.id, r]));
  const dbContacts = new Map(db.prepare('SELECT id, company_id, last_purchase FROM contacts').all().map((r) => [r.id, r]));
  const inDb = [...wonCompanies].filter((id) => dbCompanies.has(id));
  const inDbWithPurchase = inDb.filter((id) => dbCompanies.get(id).last_purchase);
  const inDbMapped = inDb.filter((id) => dbCompanies.get(id).lat != null);
  for (const d of wonDealRows) {
    if (!d.companies.some((c) => dbCompanies.has(c)) && d.contacts.some((c) => dbContacts.has(c))) reachableOnlyViaPerson++;
  }
  console.log('\nCompared with the stored data from the last sync:');
  console.log(`  distinct companies on closed-won deals: ${wonCompanies.size}`);
  console.log(`    ...that are in the map data (have at least one contact): ${inDb.length}`);
  console.log(`    ...of those, stored WITH a last purchase: ${inDbWithPurchase.length}  (should equal the line above)`);
  console.log(`    ...of those, placed on the map: ${inDbMapped.length}`);
  console.log(`    ...NOT in the map data (no contact linked, so never synced): ${wonCompanies.size - inDb.length}`);
  console.log(`  distinct contacts on closed-won deals: ${wonContacts.size} | in the map data: ${[...wonContacts].filter((id) => dbContacts.has(id)).length}`);
  console.log(`  won deals whose company is missing from the map data but a linked person is present: ${reachableOnlyViaPerson}`);
  console.log(`  companies in the map data with any purchase: ${[...dbCompanies.values()].filter((r) => r.last_purchase).length} of ${dbCompanies.size}`);
  db.close();
  if (unknownStage) console.log(`  deals in stages not found in any pipeline: ${unknownStage}`);
}

main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
