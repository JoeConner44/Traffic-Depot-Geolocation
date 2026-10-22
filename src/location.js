// Address normalisation, state filtering and the contact -> company address fallback.

const GA_BOUNDS = { latMin: 30.3, latMax: 35.1, lngMin: -85.7, lngMax: -80.7 };

function isGeorgia(state) {
  const s = (state || '').trim().toLowerCase().replace(/\./g, '');
  return s === 'ga' || s === 'georgia';
}

// Skip contacts whose state is set and not GA (blank is allowed), unless allowNonGA.
function passesStateFilter(state, allowNonGA) {
  if (allowNonGA) return true;
  const s = (state || '').trim();
  return s === '' || isGeorgia(s);
}

function inGeorgia(lat, lng) {
  return lat >= GA_BOUNDS.latMin && lat <= GA_BOUNDS.latMax && lng >= GA_BOUNDS.lngMin && lng <= GA_BOUNDS.lngMax;
}

const clean = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9#\- ]+/g, ' ').replace(/\s+/g, ' ').trim();

// "123 main st, atlanta, ga 30303". Returns null if there is not enough to geocode.
function normalizeAddress({ address, city, state, zip }, { allowNonGA = false } = {}) {
  const street = clean(address);
  const town = clean(city);
  const z = (String(zip || '').match(/\d{5}/) || [''])[0];
  let st = isGeorgia(state) ? 'ga' : clean(state);
  if (!st && !allowNonGA) st = 'ga';
  if (!street && !town && !z) return null; // state alone is not an address
  const tail = [st, z].filter(Boolean).join(' ');
  return [street, town, tail].filter(Boolean).join(', ');
}

const hasLocation = (o) => normalizeAddress(o, { allowNonGA: true }) !== null;

// Use the contact's own address if present, else the first associated company that has one.
// companies: array of { id, properties } in association order.
function resolveLocation(contact, companiesById) {
  if (hasLocation(contact)) {
    return { address: contact.address, city: contact.city, state: contact.state, zip: contact.zip, source: 'contact', companyName: null };
  }
  for (const id of contact.companyIds || []) {
    const co = companiesById.get(id);
    if (!co) continue;
    const p = co.properties || {};
    const loc = { address: p.address || '', city: p.city || '', state: p.state || '', zip: p.zip || '' };
    if (hasLocation(loc)) return { ...loc, source: 'company', companyName: p.name || null };
  }
  return { address: '', city: '', state: '', zip: '', source: null, companyName: null };
}

module.exports = { isGeorgia, passesStateFilter, inGeorgia, normalizeAddress, resolveLocation, GA_BOUNDS };
