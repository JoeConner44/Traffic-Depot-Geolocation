require('dotenv').config();
const path = require('path');

const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v).trim()));
const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const config = {
  recentDays: int(process.env.RECENT_DAYS, 90),
  includeEmailSendDate: bool(process.env.INCLUDE_EMAIL_SEND_DATE, false),
  purchaseProvider: (process.env.PURCHASE_PROVIDER || 'hubspot_deals').trim().toLowerCase(),
  allowNonGA: bool(process.env.ALLOW_NON_GA, false),

  hubspotToken: process.env.HUBSPOT_TOKEN || '',
  hubspotPortalId: (process.env.HUBSPOT_PORTAL_ID || '').trim(),
  googleKey: process.env.GOOGLE_MAPS_API_KEY || '',
  shopifyDomain: (process.env.SHOPIFY_STORE_DOMAIN || '').trim(),
  shopifyToken: process.env.SHOPIFY_ADMIN_TOKEN || '',

  appPassword: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0', // use 127.0.0.1 when a reverse proxy (Caddy/nginx) fronts the app
  trustProxy: process.env.TRUST_PROXY || '0',
  production: process.env.NODE_ENV === 'production',
  dbPath: path.resolve(process.env.DB_PATH || './data/traffic-depot.db'),
};

module.exports = config;
