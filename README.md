# Traffic Depot Geolocation

Shows Traffic Depot's HubSpot contacts as color-coded dots on a map of Georgia.

The map shows **one dot per company** (contacts with no company in HubSpot appear as individual dots). Click a company
for its name, city, status, last purchase and last contact, plus the **people** in it, each with their own purchase and
contact history and a HubSpot link. Hover any dot for a quick summary, including how long ago the last purchase and
contact were.

| Marker | Meaning |
|--------|---------|
| 🟢 Green | Last purchase within `RECENT_DAYS` (default 90) |
| 🟡 Yellow | Bought before (`RECENT_DAYS` to `COLD_DAYS` ago) and contacted within `RECENT_DAYS` |
| 🔴 Red | Bought before (`RECENT_DAYS` to `COLD_DAYS` ago) and **not** contacted within `RECENT_DAYS` |
| 🧊 Ice cube | Last purchase `COLD_DAYS` (default 365) or more ago. Replaces the dot. |
| ⚪ Grey | No purchase on record (no closed-won deal in HubSpot), however recently they were contacted |

A company's dates combine its own deals and all of its people: its last purchase is the most recent closed-won deal on
the company or any of its people, and its last contact is the most recent across the company and its people.

The sidebar has the legend, per-status toggles and counts, a **State** filter, and an **Unmapped** panel for companies
and contacts that could not be placed (with the reason).

### Changing the ice cube icon
The page uses `public/assets/ice-cube.png` if it exists, otherwise the bundled placeholder `public/assets/ice-cube.svg`.
To use your own icon, add a transparent square PNG (64x64 px or larger) named `ice-cube.png` to `public/assets/`,
commit it, and redeploy.

**Architecture:** Node.js + Express + SQLite (`better-sqlite3`). `npm run sync` pulls from HubSpot, geocodes new addresses,
and writes SQLite. The web app serves a single Leaflet/OpenStreetMap page (no build step) from `/api/contacts`, behind a
shared-password login. HubSpot and Google credentials stay on the server and are never sent to the browser.
Status (green/yellow/red) is computed when the page loads, so contacts age naturally between syncs and changing
`RECENT_DAYS` needs no re-sync.

## Quick start (demo, no credentials)

```bash
npm install
cp .env.example .env        # set APP_PASSWORD and SESSION_SECRET; leave the rest blank
npm run seed-demo           # 200 fake Georgia contacts
npm start                   # http://localhost:3000
```

Requires Node 20+. `npm run seed-demo` only touches `demo-*` rows. The first real `npm run sync` replaces them.

## Configuration (`.env`)

Copy `.env.example` to `.env`. **Never commit `.env`** (it is in `.gitignore`).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `APP_PASSWORD` | web app | – | Shared password for the map page |
| `SESSION_SECRET` | web app | – | Signs the session cookie (`openssl rand -hex 32`) |
| `HUBSPOT_TOKEN` | sync | – | HubSpot private app token |
| `HUBSPOT_PORTAL_ID` | for links | – | Builds the "Open in HubSpot" links (the number in your HubSpot URL) |
| `GOOGLE_MAPS_API_KEY` | sync | – | Google Geocoding API key |
| `RECENT_DAYS` | no | `90` | Window for "recent" |
| `COLD_DAYS` | no | `365` | A last purchase this many days ago or more gets the ice cube |
| `INCLUDE_EMAIL_SEND_DATE` | no | `false` | Also count `hs_email_last_send_date` as a contact |
| `PURCHASE_PROVIDER` | no | `hubspot_deals` | `hubspot_deals` or `shopify` |
| `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_ADMIN_TOKEN` | shopify only | – | Shopify Admin API access |
| `ALLOW_NON_GA` | no | `false` | Map contacts outside Georgia too |
| `PORT` | no | `3000` | HTTP port |
| `DB_PATH` | no | `./data/traffic-depot.db` | SQLite file (put it on a persistent disk when deploying) |
| `TRUST_PROXY` | no | `0` | Set `1` behind a reverse proxy / PaaS |
| `NODE_ENV` | no | – | `production` makes the session cookie `Secure` (HTTPS only) |

## Create the HubSpot private app

1. HubSpot → **Settings → Integrations → Private Apps → Create private app**.
2. Name it (e.g. "Traffic Depot Map"). On **Scopes**, add these **read-only** scopes:
   - `crm.objects.contacts.read`
   - `crm.objects.companies.read` (company address fallback)
   - `crm.objects.deals.read` (last purchase)
   - `crm.schemas.deals.read` (reads pipeline/stage metadata to find closed-won stages)
3. Create the app and copy the **access token** into `HUBSPOT_TOKEN`.
4. Your portal ID is the number in HubSpot URLs (`app.hubspot.com/contacts/<PORTAL_ID>/...`). Put it in `HUBSPOT_PORTAL_ID`.

No write scopes are requested, and the app never writes to HubSpot.

### Data mapping

- **Contact properties:** `firstname, lastname, email, company, address, city, state, zip, notes_last_contacted,
  hs_last_sales_activity_timestamp, hs_email_last_send_date`.
- **Last contacted** = most recent of `notes_last_contacted` and `hs_last_sales_activity_timestamp`
  (plus `hs_email_last_send_date` if `INCLUDE_EMAIL_SEND_DATE=true`).
- **Last purchase** (`hubspot_deals`) = latest `closedate` among associated deals whose stage is closed-won. Closed-won is read
  from the pipeline stage metadata (`isClosed=true`, `probability=1.0`), so custom pipelines and stage names work.
  Deal properties requested: `closedate, dealstage, amount, pipeline`.
- **Companies:** each contact belongs to its **primary** associated company. A company is placed at its own address, or
  at the address of one of its people if the company has none (the popup says so). People inside a company are not
  geocoded separately. Contacts with no company are geocoded on their own address.
- **Company purchases:** deals attached directly to the company count as well as deals attached to its people.
  Every company with a closed-won deal is on the map, even if no contact is linked to it.

### Shopify purchase provider (optional)

Set `PURCHASE_PROVIDER=shopify`, `SHOPIFY_STORE_DOMAIN`, and `SHOPIFY_ADMIN_TOKEN` (a custom app with `read_orders`; add
`read_all_orders` if you need purchases older than 60 days). The last paid, non-cancelled order is matched by contact email.
It is rate-limited to about 2 requests/second, so large lists take a while.

## Google Geocoding key

1. Google Cloud Console → create a project, enable billing, and enable the **Geocoding API**.
2. **APIs & Services → Credentials → Create API key**. Restrict it to the Geocoding API. Because the key is used only
   server-side, restrict by API (and by server IP if yours is static), not by HTTP referrer.
3. Put it in `GOOGLE_MAPS_API_KEY`.

Results are cached in `geocode_cache`, keyed by the normalized address (`123 main st, atlanta, ga 30303`), so each address
is geocoded once, across runs and across contacts that share an address. Addresses Google can't find are cached too and
retried after 30 days. Contacts whose state is set and not GA are skipped (count logged) unless `ALLOW_NON_GA=true`;
blank state is treated as GA. Each lookup tells Google to search only the contact's own state (so "Auburn, GA" can't
come back as Auburn, AL), and the state Google returns is saved with the cached result. If it doesn't match the contact's
state, the contact goes to the unmapped panel with the reason. Cache rows saved before this check existed are looked up
once more, then cached again.

## Running the sync

```bash
npm run sync
```

It fetches contacts (following pagination, retrying 429/5xx with backoff and honoring `Retry-After`), resolves deals and
company addresses, geocodes new addresses, and upserts into SQLite in one transaction. It is idempotent: re-running changes
nothing but fresh data, and the table always mirrors the latest successful sync (contacts deleted in HubSpot are pruned). A
failed run leaves the previous data intact and exits non-zero. A lock file prevents overlapping runs. Each run is logged in
the `sync_runs` table, and the page shows the last successful sync time.

### Scheduling

Cron, daily at 5:15am (adjust paths):

```cron
15 5 * * * cd /opt/traffic-depot && /usr/bin/node src/sync.js >> /var/log/td-sync.log 2>&1
```

`npm run sync` must run on the same machine/disk as the web server (it writes the same SQLite file). On a VM use cron
(see the deploy guide); on platforms where a disk attaches to one service only (Render, Fly, Railway), run it from inside
that service's own shell or scheduler.

## Deploying

**Google Cloud free-tier VM (step-by-step): see [docs/DEPLOY-GCP.md](docs/DEPLOY-GCP.md)** (setup script and config are in `deploy/`).
The generic notes below apply to other hosts. On Render a disk can only attach to a single service, so run the sync as a
scheduled command on that same service rather than as a separate Cron Job.

Any host that runs Node and has a **persistent disk** for the SQLite file works (a small VPS, Render, Fly.io with a volume, Railway
with a volume). The SQLite file must be on that disk, because the sync and the web server both use it.

1. Set env vars: `APP_PASSWORD`, `SESSION_SECRET`, `HUBSPOT_TOKEN`, `HUBSPOT_PORTAL_ID`, `GOOGLE_MAPS_API_KEY`,
   `NODE_ENV=production`, `TRUST_PROXY=1`, and `DB_PATH` on the persistent volume (e.g. `/data/traffic-depot.db`).
2. Build: `npm ci --omit=dev`. Start: `npm start`.
3. Serve it over **HTTPS** (the production session cookie is `Secure`). Hosted platforms do this for you. On a VPS put
   nginx or Caddy in front.
4. Run `npm run sync` once, then schedule it as above.
5. Health check: `GET /healthz`.

### VPS example (systemd)

```ini
[Service]
WorkingDirectory=/opt/traffic-depot
EnvironmentFile=/opt/traffic-depot/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
```

## Security notes

- The map page and `/api/contacts` require the shared-password session (HttpOnly, SameSite=Lax, 12 h expiry); login is limited to
  10 failed attempts per IP per 15 minutes.
- The browser receives names, companies, cities and dates of contacts, but never emails, street addresses, or any token or key.
- Rotate the password by changing `APP_PASSWORD`. Changing `SESSION_SECRET` signs everyone out.

## Tests

```bash
npm test
```

Covers status calculation (grey, green, yellow, red and ice cube, boundaries, config, bad dates), last-contacted merging, closed-won detection, address
normalization and the state filter, company fallback, pagination and 429 retry, and an end-to-end sync with fake HubSpot and
Google responses (idempotency, geocode caching, unmapped handling).
