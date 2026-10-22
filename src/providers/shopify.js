const { requestWithBackoff, defaultSleep } = require('../http');
const { latestDate } = require('../status');

const API_VERSION = '2025-01';

// Last purchase = most recent paid order for the customer email (Shopify Admin REST API).
// Needs the read_orders scope. Orders older than 60 days also need read_all_orders.
function createShopifyProvider({ domain, token, fetchImpl, sleep = defaultSleep, minIntervalMs = 550 }) {
  if (!domain || !token) throw new Error('SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN are required for the shopify provider');
  const host = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  async function lastOrderDate(email) {
    const q = new URLSearchParams({
      email,
      status: 'any',
      financial_status: 'paid',
      limit: '1',
      order: 'processed_at desc',
      fields: 'id,processed_at,created_at,cancelled_at',
    });
    const res = await requestWithBackoff(
      `https://${host}/admin/api/${API_VERSION}/orders.json?${q}`,
      { headers: { 'X-Shopify-Access-Token': token } },
      { fetchImpl, sleep, label: 'Shopify orders' }
    );
    const { orders = [] } = await res.json();
    return latestDate(...orders.filter((o) => !o.cancelled_at).map((o) => o.processed_at || o.created_at));
  }

  return {
    name: 'shopify',
    async getLastPurchases(contacts) {
      const out = new Map();
      const cache = new Map();
      for (const c of contacts) {
        const email = (c.email || '').trim().toLowerCase();
        if (!email) { out.set(c.id, null); continue; }
        if (!cache.has(email)) {
          cache.set(email, await lastOrderDate(email));
          await sleep(minIntervalMs); // stay under Shopify's ~2 req/s REST bucket
        }
        out.set(c.id, cache.get(email));
      }
      return out;
    },
  };
}

module.exports = { createShopifyProvider };
