const fs = require('fs');
const path = require('path');
const config = require('./config');
const { openDb } = require('./db');
const { createHubSpotClient, shapeContact } = require('./hubspot');
const { createPurchaseProvider } = require('./providers');
const { createGeocoder } = require('./geocode');
const { latestDate } = require('./status');
const { passesStateFilter, normalizeAddress, resolveCompanyLocation } = require('./location');
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

// Geocode one place. Returns { coords, reason } where coords is { lat, lng, state } or null.
async function geocodePlace(loc, geocoder, config, nothingToGeocode) {
  const key = normalizeAddress(loc, { allowNonGA: config.allowNonGA });
  if (!key) return { coords: null, reason: nothingToGeocode };
  const want = expectedState(loc.state, config);
  const coords = await geocoder.geocode(key, want);
  if (!coords) return { coords: null, reason: `Address could not be geocoded (${key})` };
  if (want && coords.state && coords.state !== want) return { coords: null, reason: `Address says ${want} but geocoded to ${coords.state} (${key})` };
  return { coords, reason: null };
}

async function runSync({ db, config, hubspot, provider, geocoder, log = console.log }) {
  // 1. Contacts (+ association ids)
  const raw = await hubspot.fetchAllContacts();
  const all = raw.map(shapeContact);
  log(`Fetched ${all.length} contacts from HubSpot.`);

  // 2. State filter on the contact's own state (before any geocoding or deal lookups)
  const contacts = all.filter((c) => passesStateFilter(c.state, config.allowNonGA));
  let skipped = all.length - contacts.length;
  log(`Skipped ${skipped} contacts outside Georgia (ALLOW_NON_GA=${config.allowNonGA}).`);

  // 3. Companies: each contact belongs to its primary company; contacts without one stay individuals.
  const companyIds = [...new Set(contacts.map((c) => c.primaryCompanyId).filter(Boolean))];
  const companyRecords = await hubspot.fetchCompanies(companyIds);
  const companiesById = new Map(companyRecords.map((co) => [String(co.id), co]));
  const peopleByCompany = new Map();
  for (const c of contacts) {
    if (!c.primaryCompanyId) continue;
    if (!peopleByCompany.has(c.primaryCompanyId)) peopleByCompany.set(c.primaryCompanyId, []);
    peopleByCompany.get(c.primaryCompanyId).push(c);
  }

  // 4. Purchases (people, and deals attached directly to companies)
  const purchases = await provider.getLastPurchases(contacts, companyIds);
  log(`Purchase dates resolved via ${provider.name}.`);

  // 5. Companies: location, geocode, aggregate dates
  const now = new Date().toISOString();
  const contactedAt = (c) => latestDate(c.notesLastContacted, c.lastSalesActivity, config.includeEmailSendDate ? c.emailLastSend : null);
  const companyRows = [];
  const skippedCompanies = new Set();
  let companiesMapped = 0, companiesUnmapped = 0;
  for (const id of companyIds) {
    const people = peopleByCompany.get(id) || [];
    const record = companiesById.get(id);
    const props = (record && record.properties) || {};
    const loc = resolveCompanyLocation(record, people);
    if (!passesStateFilter(loc.state, config.allowNonGA)) { skippedCompanies.add(id); skipped += people.length; continue; }

    const { coords, reason } = await geocodePlace(loc, geocoder, config, 'No address, city or ZIP on the company or any of its people');
    coords ? companiesMapped++ : companiesUnmapped++;
    companyRows.push({
      id,
      name: props.name || (people.find((p) => p.company) || {}).company || '(unnamed company)',
      address: loc.address, city: loc.city, state: loc.state || (coords && coords.state) || '', zip: loc.zip,
      location_source: loc.source,
      last_contacted: latestDate(props.notes_last_contacted, props.hs_last_sales_activity_timestamp, ...people.map(contactedAt)),
      last_purchase: latestDate(purchases.byCompany.get(id), ...people.map((p) => purchases.byContact.get(p.id))),
      lat: coords ? coords.lat : null, lng: coords ? coords.lng : null,
      unmapped_reason: coords ? null : reason,
      updated_at: now,
    });
  }
  if (skippedCompanies.size) log(`Skipped ${skippedCompanies.size} companies (and their people) whose address is outside Georgia.`);

  // 6. Contacts. People in a company are shown inside it, so they are not geocoded themselves; individuals are.
  const companyRowsById = new Map(companyRows.map((r) => [r.id, r]));
  const contactRows = [];
  let individualsMapped = 0, individualsUnmapped = 0;
  for (const c of contacts) {
    if (c.primaryCompanyId && skippedCompanies.has(c.primaryCompanyId)) continue;
    const inCompany = !!c.primaryCompanyId;
    let coords = null, reason = null;
    const loc = { address: c.address, city: c.city, state: c.state, zip: c.zip };
    if (!inCompany) {
      ({ coords, reason } = await geocodePlace(loc, geocoder, config, 'No address, city or ZIP on the contact'));
      coords ? individualsMapped++ : individualsUnmapped++;
    }
    const company = inCompany ? companyRowsById.get(c.primaryCompanyId) : null;
    contactRows.push({
      id: c.id,
      firstname: c.firstname, lastname: c.lastname, email: c.email,
      company: c.company || (company ? company.name : ''),
      address: c.address, city: c.city, state: c.state || (coords && coords.state) || '', zip: c.zip,
      company_id: inCompany ? c.primaryCompanyId : null,
      location_source: inCompany ? null : 'contact',
      last_contacted: contactedAt(c),
      last_purchase: purchases.byContact.get(c.id) || null,
      lat: coords ? coords.lat : null, lng: coords ? coords.lng : null,
      unmapped_reason: coords || inCompany ? null : reason,
      updated_at: now,
    });
  }

  // 7. Write atomically. Anything not touched by this run (deleted in HubSpot, now filtered out, or demo data)
  //    is pruned, so the tables always mirror the latest successful sync.
  const upsertContact = db.prepare(`
    INSERT INTO contacts (id, firstname, lastname, email, company, address, city, state, zip, company_id, location_source,
      last_contacted, last_purchase, lat, lng, unmapped_reason, updated_at)
    VALUES (@id, @firstname, @lastname, @email, @company, @address, @city, @state, @zip, @company_id, @location_source,
      @last_contacted, @last_purchase, @lat, @lng, @unmapped_reason, @updated_at)
    ON CONFLICT(id) DO UPDATE SET firstname=@firstname, lastname=@lastname, email=@email, company=@company,
      address=@address, city=@city, state=@state, zip=@zip, company_id=@company_id, location_source=@location_source,
      last_contacted=@last_contacted, last_purchase=@last_purchase, lat=@lat, lng=@lng,
      unmapped_reason=@unmapped_reason, updated_at=@updated_at`);
  const upsertCompany = db.prepare(`
    INSERT INTO companies (id, name, address, city, state, zip, location_source, last_contacted, last_purchase,
      lat, lng, unmapped_reason, updated_at)
    VALUES (@id, @name, @address, @city, @state, @zip, @location_source, @last_contacted, @last_purchase,
      @lat, @lng, @unmapped_reason, @updated_at)
    ON CONFLICT(id) DO UPDATE SET name=@name, address=@address, city=@city, state=@state, zip=@zip,
      location_source=@location_source, last_contacted=@last_contacted, last_purchase=@last_purchase,
      lat=@lat, lng=@lng, unmapped_reason=@unmapped_reason, updated_at=@updated_at`);
  let pruned = 0;
  db.transaction(() => {
    for (const r of companyRows) upsertCompany.run(r);
    for (const r of contactRows) upsertContact.run(r);
    pruned = db.prepare('DELETE FROM contacts WHERE updated_at <> ?').run(now).changes
      + db.prepare('DELETE FROM companies WHERE updated_at <> ?').run(now).changes;
  })();

  const summary = {
    fetched: all.length, skippedNonGA: skipped,
    companies: companyRows.length, companiesMapped, companiesUnmapped,
    individuals: individualsMapped + individualsUnmapped, individualsMapped, individualsUnmapped,
    people: contactRows.length - (individualsMapped + individualsUnmapped),
    pruned, geocodeCacheHits: geocoder.stats.cacheHits, geocodeApiCalls: geocoder.stats.apiCalls,
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
