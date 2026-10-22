const { createHubspotDealsProvider } = require('./hubspotDeals');
const { createShopifyProvider } = require('./shopify');

function createPurchaseProvider(config, { hubspot }) {
  switch (config.purchaseProvider) {
    case 'hubspot_deals':
      return createHubspotDealsProvider({ hubspot });
    case 'shopify':
      return createShopifyProvider({ domain: config.shopifyDomain, token: config.shopifyToken });
    default:
      throw new Error(`Unknown PURCHASE_PROVIDER "${config.purchaseProvider}" (use hubspot_deals or shopify)`);
  }
}

module.exports = { createPurchaseProvider };
