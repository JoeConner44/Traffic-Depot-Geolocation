// US state name/abbreviation handling. HubSpot "state" values are free text ("GA", "Georgia", "georgia ").
const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([abbr, name]) => [name.toLowerCase(), abbr]));

// Returns a 2-letter code, or '' if blank/unrecognised.
function normalizeState(raw) {
  const s = String(raw || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
  if (!s) return '';
  if (BY_NAME[s]) return BY_NAME[s];
  const up = s.toUpperCase();
  return STATES[up] ? up : '';
}

module.exports = { STATES, normalizeState };
