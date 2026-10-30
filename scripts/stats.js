// Prints counts only (no names, emails or addresses) to help judge data quality:  node scripts/stats.js
const { openDb } = require('../src/db');
const config = require('../src/config');
const { computeStatus } = require('../src/status');

const db = openDb();
const opts = { now: Date.now(), recentDays: config.recentDays, coldDays: config.coldDays };
const tally = (rows) => rows.reduce((t, r) => {
  const k = computeStatus({ lastPurchase: r.last_purchase, lastContacted: r.last_contacted }, opts);
  t[k] = (t[k] || 0) + 1; return t;
}, {});
const reasons = (table, where) => db.prepare(
  `SELECT substr(unmapped_reason, 1, instr(unmapped_reason || char(40), char(40)) - 1) AS reason, COUNT(*) AS n
   FROM ${table} WHERE ${where} GROUP BY reason ORDER BY n DESC`).all();

const companies = db.prepare('SELECT * FROM companies').all();
const individuals = db.prepare('SELECT * FROM contacts WHERE company_id IS NULL').all();
const hasName = (r) => String(r.company || '').trim() !== '';

console.log('Companies:', companies.length, '| mapped', companies.filter((r) => r.lat != null).length);
console.log('  status of mapped companies:', tally(companies.filter((r) => r.lat != null)));
console.log('  unmapped companies by reason:', reasons('companies', 'lat IS NULL'));
console.log('People inside companies:', db.prepare('SELECT COUNT(*) n FROM contacts WHERE company_id IS NOT NULL').get().n);
console.log('Individuals (no company link):', individuals.length, '| mapped', individuals.filter((r) => r.lat != null).length);
console.log('  ...that have a company NAME typed in:', individuals.filter(hasName).length,
  '| unmapped and have a name:', individuals.filter((r) => r.lat == null && hasName(r)).length);
console.log('  unmapped individuals by reason:', reasons('contacts', 'company_id IS NULL AND lat IS NULL'));
const names = db.prepare("SELECT company, COUNT(*) n FROM contacts WHERE company_id IS NULL AND TRIM(COALESCE(company,'')) <> '' GROUP BY LOWER(TRIM(company))").all();
console.log('  distinct company names among those individuals:', names.length,
  '| names shared by 2+ individuals:', names.filter((r) => r.n > 1).length);
db.close();
