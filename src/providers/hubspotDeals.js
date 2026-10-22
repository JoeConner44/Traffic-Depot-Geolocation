const { latestDate } = require('../status');

// Last purchase = close date of the most recent closed-won deal associated with the contact.
function lastPurchaseFromDeals(dealIds, dealsById, closedWonStages) {
  const dates = [];
  for (const id of dealIds) {
    const d = dealsById.get(id);
    if (!d) continue;
    const p = d.properties || {};
    if (!closedWonStages.has(`${p.pipeline}:${p.dealstage}`)) continue;
    dates.push(p.closedate);
  }
  return latestDate(...dates);
}

function createHubspotDealsProvider({ hubspot }) {
  return {
    name: 'hubspot_deals',
    // contacts: shaped contacts; returns Map(contactId -> ISO date | null)
    async getLastPurchases(contacts) {
      const closedWon = await hubspot.fetchClosedWonStages();
      if (closedWon.size === 0) console.warn('No closed-won deal stages found in HubSpot pipelines; all purchases will be empty.');
      const deals = await hubspot.fetchDeals(contacts.flatMap((c) => c.dealIds));
      const byId = new Map(deals.map((d) => [String(d.id), d]));
      const out = new Map();
      for (const c of contacts) out.set(c.id, lastPurchaseFromDeals(c.dealIds, byId, closedWon));
      return out;
    },
  };
}

module.exports = { createHubspotDealsProvider, lastPurchaseFromDeals };
