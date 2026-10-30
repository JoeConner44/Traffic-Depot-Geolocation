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

  const selectContacts = db.prepare('SELECT * FROM contacts');
  const selectCompanies = db.prepare('SELECT * FROM companies');
  const lastRun = db.prepare('SELECT finished_at, ok, summary FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
  const lastOk = db.prepare('SELECT finished_at FROM sync_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1');

  const recordUrl = (kind, id) => {
    if (!cfg.hubspotPortalId || String(id).startsWith('demo-')) return null;
    return `https://app.hubspot.com/contacts/${encodeURIComponent(cfg.hubspotPortalId)}/record/${kind === 'company' ? '0-2' : '0-1'}/${encodeURIComponent(id)}`;
  };

  // Companies are the dots; their people are listed inside. Contacts with no company are individual dots.
  app.get('/api/contacts', (req, res) => {
    const opts = { now: Date.now(), recentDays: cfg.recentDays, coldDays: cfg.coldDays };
    const statusOf = (r) => computeStatus({ lastPurchase: r.last_purchase, lastContacted: r.last_contacted }, opts);

    const companyRows = selectCompanies.all();
    const knownCompany = new Set(companyRows.map((r) => r.id));
    const peopleOf = new Map();
    const individuals = [];
    for (const r of selectContacts.all()) {
      if (r.company_id && knownCompany.has(r.company_id)) {
        if (!peopleOf.has(r.company_id)) peopleOf.set(r.company_id, []);
        peopleOf.get(r.company_id).push(r);
      } else {
        individuals.push(r);
      }
    }

    const personName = (r) => [r.firstname, r.lastname].filter(Boolean).join(' ') || '(no name)';
    const person = (r) => ({
      id: r.id, name: personName(r), status: statusOf(r),
      lastPurchase: r.last_purchase, lastContacted: r.last_contacted, hubspotUrl: recordUrl('contact', r.id),
    });
    // Blank state on a mapped place: it was only accepted because it geocoded inside Georgia.
    const stateOf = (r) => {
      const st = normalizeState(r.state);
      return st || (r.lat != null && r.lng != null && inGeorgia(r.lat, r.lng) ? 'GA' : '');
    };
    const place = (kind, r, name, people) => ({
      kind, id: r.id, name, company: kind === 'person' ? r.company || '' : '',
      city: r.city || '', state: stateOf(r), status: statusOf(r),
      lastPurchase: r.last_purchase, lastContacted: r.last_contacted,
      locationSource: r.location_source, hubspotUrl: recordUrl(kind, r.id),
      people: people.map(person).sort((a, b) => (Date.parse(b.lastContacted) || 0) - (Date.parse(a.lastContacted) || 0)),
    });

    const out = { mapped: [], unmapped: [], counts: { green: 0, yellow: 0, red: 0, ice: 0, grey: 0, unmapped: 0 } };
    const add = (item, r) => {
      if (r.lat != null && r.lng != null) {
        out.mapped.push({ ...item, lat: r.lat, lng: r.lng });
        out.counts[item.status]++;
      } else {
        out.unmapped.push({ ...item, reason: r.unmapped_reason });
        out.counts.unmapped++;
      }
    };
    for (const r of companyRows) add(place('company', r, r.name || '(unnamed company)', peopleOf.get(r.id) || []), r);
    for (const r of individuals) add(place('person', r, personName(r), []), r);

    const run = lastRun.get(), ok = lastOk.get();
    out.stateNames = STATES;
    out.recentDays = cfg.recentDays;
    out.coldDays = cfg.coldDays;
    out.lastSync = ok ? ok.finished_at : null;
    out.lastSyncFailed = !!(run && !run.ok);
    res.set('Cache-Control', 'no-store').json(out);
  });

  return app;
}

if (require.main === module) {
  const db = openDb();
  const app = createApp({ db });
  app.listen(config.port, config.host, () => console.log(`Traffic Depot map listening on ${config.host}:${config.port}`));
}

module.exports = { createApp, makeSession, validSession };
