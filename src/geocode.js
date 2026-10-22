const { requestWithBackoff, defaultSleep } = require('./http');

const NEGATIVE_TTL_DAYS = 30; // retry "not found" addresses after this long

class GeocodeError extends Error {}

function createGeocoder({ db, apiKey, fetchImpl, sleep = defaultSleep, throttleMs = 25 }) {
  const getCached = db.prepare('SELECT lat, lng, status, created_at FROM geocode_cache WHERE address_key = ?');
  const putCache = db.prepare(
    `INSERT INTO geocode_cache (address_key, lat, lng, status, formatted, created_at)
     VALUES (@key, @lat, @lng, @status, @formatted, @now)
     ON CONFLICT(address_key) DO UPDATE SET lat=@lat, lng=@lng, status=@status, formatted=@formatted, created_at=@now`
  );
  const stats = { cacheHits: 0, apiCalls: 0, notFound: 0 };

  // Returns { lat, lng } or null (address could not be geocoded). Throws on key/quota problems.
  async function geocode(key) {
    const hit = getCached.get(key);
    if (hit) {
      if (hit.status === 'ok') { stats.cacheHits++; return { lat: hit.lat, lng: hit.lng }; }
      const ageDays = (Date.now() - Date.parse(hit.created_at)) / 86400000;
      if (ageDays < NEGATIVE_TTL_DAYS) { stats.cacheHits++; return null; }
    }
    if (!apiKey) throw new GeocodeError('GOOGLE_MAPS_API_KEY is not set');

    const url = 'https://maps.googleapis.com/maps/api/geocode/json?' +
      new URLSearchParams({ address: key, components: 'country:US', key: apiKey });
    const res = await requestWithBackoff(url, {}, { fetchImpl, sleep, label: 'Google Geocoding' });
    const body = await res.json();
    stats.apiCalls++;
    await sleep(throttleMs);

    const now = new Date().toISOString();
    if (body.status === 'OK' && body.results && body.results[0]) {
      const r = body.results[0];
      putCache.run({ key, lat: r.geometry.location.lat, lng: r.geometry.location.lng, status: 'ok', formatted: r.formatted_address, now });
      return { lat: r.geometry.location.lat, lng: r.geometry.location.lng };
    }
    if (body.status === 'ZERO_RESULTS') {
      stats.notFound++;
      putCache.run({ key, lat: null, lng: null, status: 'not_found', formatted: null, now });
      return null;
    }
    // REQUEST_DENIED, OVER_QUERY_LIMIT, INVALID_REQUEST, ...: don't cache; surface it.
    throw new GeocodeError(`Google Geocoding returned ${body.status}${body.error_message ? ': ' + body.error_message : ''}`);
  }

  return { geocode, stats };
}

module.exports = { createGeocoder, GeocodeError };
