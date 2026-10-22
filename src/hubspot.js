const { requestWithBackoff } = require('./http');

const BASE = 'https://api.hubapi.com';

const CONTACT_PROPS = [
  'firstname', 'lastname', 'email', 'company', 'address', 'city', 'state', 'zip',
  'notes_last_contacted', 'hs_last_sales_activity_timestamp', 'hs_email_last_send_date',
];
const DEAL_PROPS = ['closedate', 'dealstage', 'amount', 'pipeline'];
const COMPANY_PROPS = ['name', 'address', 'city', 'state', 'zip'];

function createHubSpotClient({ token, fetchImpl, sleep } = {}) {
  if (!token) throw new Error('HUBSPOT_TOKEN is not set');

  async function call(method, pathAndQuery, body) {
    const res = await requestWithBackoff(
      BASE + pathAndQuery,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      },
      { fetchImpl, sleep, label: `HubSpot ${method} ${pathAndQuery.split('?')[0]}` }
    );
    return res.json();
  }

  // All contacts, following paging.next.after. Includes company/deal association ids.
  async function fetchAllContacts() {
    const out = [];
    let after;
    do {
      const q = new URLSearchParams({
        limit: '100',
        properties: CONTACT_PROPS.join(','),
        associations: 'companies,deals',
        archived: 'false',
      });
      if (after) q.set('after', after);
      const page = await call('GET', `/crm/v3/objects/contacts?${q}`);
      out.push(...(page.results || []));
      after = page.paging && page.paging.next && page.paging.next.after;
    } while (after);
    return out;
  }

  // Batch-read up to 100 ids per call.
  async function batchRead(objectType, ids, properties) {
    const unique = [...new Set(ids)];
    const out = [];
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const res = await call('POST', `/crm/v3/objects/${objectType}/batch/read`, {
        properties,
        inputs: chunk.map((id) => ({ id })),
      });
      out.push(...(res.results || []));
    }
    return out;
  }

  const fetchDeals = (ids) => batchRead('deals', ids, DEAL_PROPS);
  const fetchCompanies = (ids) => batchRead('companies', ids, COMPANY_PROPS);

  // Set of "pipelineId:stageId" for stages whose metadata marks them closed-won.
  async function fetchClosedWonStages() {
    const res = await call('GET', '/crm/v3/pipelines/deals');
    return closedWonStagesFromPipelines(res.results || []);
  }

  return { fetchAllContacts, fetchDeals, fetchCompanies, fetchClosedWonStages };
}

function closedWonStagesFromPipelines(pipelines) {
  const set = new Set();
  for (const p of pipelines) {
    for (const s of p.stages || []) {
      const m = s.metadata || {};
      const closed = String(m.isClosed).toLowerCase() === 'true';
      const won = Number(m.probability) === 1;
      if (closed && won) set.add(`${p.id}:${s.id}`);
    }
  }
  return set;
}

// Normalise a raw HubSpot contact record into our flat shape.
function shapeContact(raw) {
  const p = raw.properties || {};
  const assoc = raw.associations || {};
  const ids = (key) => ((assoc[key] && assoc[key].results) || []).map((r) => String(r.id));
  return {
    id: String(raw.id),
    firstname: p.firstname || '',
    lastname: p.lastname || '',
    email: p.email || '',
    company: p.company || '',
    address: p.address || '',
    city: p.city || '',
    state: p.state || '',
    zip: p.zip || '',
    notesLastContacted: p.notes_last_contacted || null,
    lastSalesActivity: p.hs_last_sales_activity_timestamp || null,
    emailLastSend: p.hs_email_last_send_date || null,
    companyIds: ids('companies'),
    dealIds: ids('deals'),
  };
}

module.exports = { createHubSpotClient, closedWonStagesFromPipelines, shapeContact, CONTACT_PROPS, DEAL_PROPS };
