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
    // Companies with at least one closed-won deal. They are customers even if no contact is linked to them.
    async getPurchasingCompanyIds() {
      const closedWon = await hubspot.fetchClosedWonStages();
      const ids = new Set();
      for (const d of await hubspot.fetchAllDeals()) {
        const p = d.properties || {};
        if (!closedWon.has(`${p.pipeline}:${p.dealstage}`)) continue;
        for (const r of ((d.associations && d.associations.companies && d.associations.companies.results) || [])) ids.add(String(r.id));
      }
      return [...ids];
    },
    // contacts: shaped contacts; companyIds: ids of their companies.
    // Returns { byContact: Map(contactId -> ISO|null), byCompany: Map(companyId -> ISO|null) }
    async getLastPurchases(contacts, companyIds = []) {
      const closedWon = await hubspot.fetchClosedWonStages();
      if (closedWon.size === 0) console.warn('No closed-won deal stages found in HubSpot pipelines; all purchases will be empty.');
      const companyDeals = companyIds.length ? await hubspot.fetchCompanyDealIds(companyIds) : new Map();
      const dealIds = contacts.flatMap((c) => c.dealIds).concat([...companyDeals.values()].flat());
      const deals = await hubspot.fetchDeals(dealIds);
      const byId = new Map(deals.map((d) => [String(d.id), d]));
      const byContact = new Map();
      for (const c of contacts) byContact.set(c.id, lastPurchaseFromDeals(c.dealIds, byId, closedWon));
      const byCompany = new Map();
      for (const id of companyIds) byCompany.set(id, lastPurchaseFromDeals(companyDeals.get(id) || [], byId, closedWon));
      return { byContact, byCompany };
    },
  };
}

module.exports = { createHubspotDealsProvider, lastPurchaseFromDeals };
