const crypto = require('crypto');
const path = require('path');
const express = require('express');
const config = require('./config');
const { openDb } = require('./db');
const { computeStatus } = require('./status');
const { normalizeState, STATES } = require('./states');
const { inGeorgia } = require('./location');

const COOKIE = 'td_session';
const SESSION_MS = 12 * 3600 * 1000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (v, secret) => crypto.createHmac('sha256', secret).update(v).digest('hex');

function makeSession(secret) {
  const exp = String(Date.now() + SESSION_MS);
  return `${exp}.${sign(exp, secret)}`;
}
function validSession(token, secret) {
  if (!token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp, secret));
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const LOGIN_HTML = (error) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Traffic Depot Map – Sign in</title>
<style>body{font:16px system-ui,sans-serif;background:#f4f5f7;display:grid;place-items:center;height:100vh;margin:0}
form{background:#fff;padding:32px;border-radius:10px;box-shadow:0 2px 12px #0002;width:300px}
h1{font-size:20px;margin:0 0 16px}input,button{width:100%;box-sizing:border-box;padding:10px;font-size:16px;margin-top:10px}
button{background:#1d4ed8;color:#fff;border:0;border-radius:6px;cursor:pointer}.err{color:#b91c1c;margin-top:10px;font-size:14px}</style></head>
<body><form method="post" action="/login"><h1>Traffic Depot Map</h1>
<input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password">
<button type="submit">Sign in</button>${error ? `<div class="err">${error}</div>` : ''}</form></body></html>`;

function createApp({ db, cfg = config }) {
  if (!cfg.appPassword || !cfg.sessionSecret) {
    throw new Error('APP_PASSWORD and SESSION_SECRET must be set (see .env.example)');
  }
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy !== '0' && cfg.trustProxy !== '') app.set('trust proxy', /^\d+$/.test(cfg.trustProxy) ? Number(cfg.trustProxy) : cfg.trustProxy);
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' });
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // --- login with a simple per-IP attempt limiter ---
  const attempts = new Map();
  const WINDOW = 15 * 60 * 1000, MAX = 10;
  const tooMany = (ip) => {
    const a = (attempts.get(ip) || []).filter((t) => Date.now() - t < WINDOW);
    attempts.set(ip, a);
    return a.length >= MAX;
  };

  app.get('/login', (req, res) => res.type('html').send(LOGIN_HTML()));
  app.post('/login', (req, res) => {
    if (tooMany(req.ip)) return res.status(429).type('html').send(LOGIN_HTML('Too many attempts. Try again later.'));
    if (!safeEqual(req.body.password || '', cfg.appPassword)) {
      attempts.get(req.ip).push(Date.now());
      return res.status(401).type('html').send(LOGIN_HTML('Incorrect password.'));
    }
    attempts.delete(req.ip);
    res.cookie(COOKIE, makeSession(cfg.sessionSecret), {
      httpOnly: true, sameSite: 'lax', secure: cfg.production, maxAge: SESSION_MS, path: '/',
    });
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect('/login');
  });

  // --- everything below requires a session ---
  app.use((req, res, next) => {
    if (validSession(readCookie(req, COOKIE), cfg.sessionSecret)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    res.redirect('/login');
  });

  app.use('/vendor/leaflet', express.static(path.dirname(require.resolve('leaflet/package.json')) + '/dist'));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const selectAll = db.prepare('SELECT * FROM contacts');
  const lastRun = db.prepare('SELECT finished_at, ok, summary FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
  const lastOk = db.prepare('SELECT finished_at FROM sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1');

  app.get('/api/contacts', (req, res) => {
    const now = Date.now();
    const out = { mapped: [], unmapped: [], counts: { green: 0, yellow: 0, red: 0, unmapped: 0 } };
    for (const r of selectAll.all()) {
      const status = computeStatus({ lastPurchase: r.last_purchase, lastContacted: r.last_contacted }, { now, recentDays: cfg.recentDays });
      const demo = r.id.startsWith('demo-');
      const mappedPoint = r.lat != null && r.lng != null;
      // Blank state on a mapped contact: it was only accepted because it geocoded inside Georgia.
      let state = normalizeState(r.state);
      if (!state && mappedPoint && inGeorgia(r.lat, r.lng)) state = 'GA';
      const c = {
        id: r.id,
        name: [r.firstname, r.lastname].filter(Boolean).join(' ') || r.email || '(no name)',
        company: r.company || '',
        city: r.city || '',
        state,
        lastPurchase: r.last_purchase,
        lastContacted: r.last_contacted,
        locationSource: r.location_source,
        status,
        hubspotUrl: !demo && cfg.hubspotPortalId ? `https://app.hubspot.com/contacts/${encodeURIComponent(cfg.hubspotPortalId)}/record/0-1/${encodeURIComponent(r.id)}` : null,
      };
      if (r.lat != null && r.lng != null) {
        out.mapped.push({ ...c, lat: r.lat, lng: r.lng });
        out.counts[status]++;
      } else {
        out.unmapped.push({ ...c, reason: r.unmapped_reason });
        out.counts.unmapped++;
      }
    }
    const run = lastRun.get(), ok = lastOk.get();
    out.stateNames = STATES;
    out.recentDays = cfg.recentDays;
    out.lastSync = ok ? ok.finished_at : null;
    out.lastSyncFailed = !!(run && !run.ok);
    res.set('Cache-Control', 'no-store').json(out);
  });

  return app;
}

if (require.main === module) {
  const db = openDb();
  const app = createApp({ db });
  app.listen(config.port, () => console.log(`Traffic Depot map listening on :${config.port}`));
}

module.exports = { createApp, makeSession, validSession };
