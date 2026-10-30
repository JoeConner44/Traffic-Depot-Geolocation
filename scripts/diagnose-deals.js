// Counts-only report on HubSpot deals: which stages exist, which count as "closed won", how many deals sit in each,
// when they closed, and whether they are linked to contacts/companies. Prints no customer data.
//   node scripts/diagnose-deals.js
const config = require('../src/config');
const { createHubSpotClient, closedWonStagesFromPipelines } = require('../src/hubspot');

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
  if (unknownStage) console.log(`  deals in stages not found in any pipeline: ${unknownStage}`);
}

main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
