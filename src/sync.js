const fs = require('fs');
const path = require('path');
const config = require('./config');
const { openDb } = require('./db');
const { createHubSpotClient, shapeContact } = require('./hubspot');
const { createPurchaseProvider } = require('./providers');
const { createGeocoder } = require('./geocode');
const { latestDate } = require('./status');
const { passesStateFilter, normalizeAddress, resolveLocation } = require('./location');
const { normalizeState } = require('./states');

const LOCK_STALE_MS = 2 * 3600 * 1000;

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < LOCK_STALE_MS) throw new Error(`Another sync is running (lock ${file}, ${Math.round(age / 60000)} min old).`);
    fs.writeFileSync(file, String(process.pid)); // stale lock from a crashed run
  }
  return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
}

// The state a contact's location should be in: its own state, or Georgia when the state is blank and only
// Georgia is allowed. '' means "any" (blank state with ALLOW_NON_GA).
function expectedState(state, config) {
  return normalizeState(state) || (config.allowNonGA ? '' : 'GA');
}

async function runSync({ db, config, hubspot, provider, geocoder, log = console.log }) {
  // 1. Contacts (+ association ids)
  const raw = await hubspot.fetchAllContacts();
  const all = raw.map(shapeContact);
  log(`Fetched ${all.length} contacts from HubSpot.`);

  // 2. State filter (before any geocoding or deal lookups)
  const contacts = all.filter((c) => passesStateFilter(c.state, config.allowNonGA));
  const skippedState = all.length - contacts.length;
  log(`Skipped ${skippedState} contacts outside Georgia (ALLOW_NON_GA=${config.allowNonGA}).`);

  // 3. Company records, only for contacts that need the address fallback
  const needsCompany = contacts.filter((c) => !normalizeAddress(c, { allowNonGA: true }) && c.companyIds.length);
  const companies = await hubspot.fetchCompanies(needsCompany.flatMap((c) => c.companyIds));
  const companiesById = new Map(companies.map((co) => [String(co.id), co]));

  // 4. Purchases
  const purchases = await provider.getLastPurchases(contacts);
  log(`Purchase dates resolved via ${provider.name}.`);

  // 5. Geocode + build rows
  const now = new Date().toISOString();
  const rows = [];
  let mapped = 0, unmapped = 0, fromCompany = 0, skippedCompanyState = 0;
  for (const c of contacts) {
    const loc = resolveLocation(c, companiesById);
    if (loc.source === 'company' && !passesStateFilter(loc.state, config.allowNonGA)) { skippedCompanyState++; continue; }

    const key = normalizeAddress(loc, { allowNonGA: config.allowNonGA });
    let coords = null;
    let reason = null;
    if (!key) reason = 'No address, city or ZIP on the contact or its company';
    else {
      const want = expectedState(loc.state, config);
      coords = await geocoder.geocode(key, want);
      if (!coords) reason = `Address could not be geocoded (${key})`;
      else if (want && coords.state && coords.state !== want) { reason = `Address says ${want} but geocoded to ${coords.state} (${key})`; coords = null; }
    }
    coords ? mapped++ : unmapped++;
    if (loc.source === 'company') fromCompany++;

    rows.push({
      id: c.id,
      firstname: c.firstname, lastname: c.lastname, email: c.email,
      company: c.company || loc.companyName || '',
      address: loc.address, city: loc.city, state: loc.state || (coords && coords.state) || '', zip: loc.zip,
      location_source: loc.source,
      last_contacted: latestDate(c.notesLastContacted, c.lastSalesActivity, config.includeEmailSendDate ? c.emailLastSend : null),
      last_purchase: purchases.get(c.id) || null,
      lat: coords ? coords.lat : null, lng: coords ? coords.lng : null,
      unmapped_reason: coords ? null : reason,
      updated_at: now,
    });
  }
  if (skippedCompanyState) log(`Skipped ${skippedCompanyState} more contacts whose company address is outside Georgia.`);

  // 6. Write atomically. Anything not touched by this run (deleted in HubSpot, now filtered out, or demo data)
  //    is pruned, so the table always mirrors the latest successful sync.
  const upsert = db.prepare(`
    INSERT INTO contacts (id, firstname, lastname, email, company, address, city, state, zip, location_source,
      last_contacted, last_purchase, lat, lng, unmapped_reason, updated_at)
    VALUES (@id, @firstname, @lastname, @email, @company, @address, @city, @state, @zip, @location_source,
      @last_contacted, @last_purchase, @lat, @lng, @unmapped_reason, @updated_at)
    ON CONFLICT(id) DO UPDATE SET firstname=@firstname, lastname=@lastname, email=@email, company=@company,
      address=@address, city=@city, state=@state, zip=@zip, location_source=@location_source,
      last_contacted=@last_contacted, last_purchase=@last_purchase, lat=@lat, lng=@lng,
      unmapped_reason=@unmapped_reason, updated_at=@updated_at`);
  let pruned = 0;
  db.transaction(() => {
    for (const r of rows) upsert.run(r);
    pruned = db.prepare('DELETE FROM contacts WHERE updated_at <> ?').run(now).changes;
  })();

  const summary = {
    fetched: all.length, skippedNonGA: skippedState + skippedCompanyState, stored: rows.length,
    mapped, unmapped, addressFromCompany: fromCompany, pruned,
    geocodeCacheHits: geocoder.stats.cacheHits, geocodeApiCalls: geocoder.stats.apiCalls,
  };
  log('Sync complete:', JSON.stringify(summary));
  return summary;
}

async function main() {
  const missing = [];
  if (!config.hubspotToken) missing.push('HUBSPOT_TOKEN');
  if (!config.googleKey) missing.push('GOOGLE_MAPS_API_KEY');
  if (missing.length) { console.error(`Missing required env: ${missing.join(', ')} (see .env.example)`); process.exit(2); }

  const release = acquireLock(config.dbPath + '.sync.lock');
  const db = openDb();
  const started = new Date().toISOString();
  const runId = db.prepare('INSERT INTO sync_runs (started_at) VALUES (?)').run(started).lastInsertRowid;
  try {
    const hubspot = createHubSpotClient({ token: config.hubspotToken });
    const provider = createPurchaseProvider(config, { hubspot });
    const geocoder = createGeocoder({ db, apiKey: config.googleKey });
    const summary = await runSync({ db, config, hubspot, provider, geocoder });
    db.prepare('UPDATE sync_runs SET finished_at=?, ok=1, summary=? WHERE id=?').run(new Date().toISOString(), JSON.stringify(summary), runId);
  } catch (err) {
    db.prepare('UPDATE sync_runs SET finished_at=?, ok=0, summary=? WHERE id=?').run(new Date().toISOString(), String(err.message), runId);
    console.error('Sync failed:', err.message);
    process.exitCode = 1;
  } finally {
    release();
    db.close();
  }
}

if (require.main === module) main();

module.exports = { runSync, expectedState };
