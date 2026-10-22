const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id               TEXT PRIMARY KEY,          -- HubSpot contact id
  firstname        TEXT,
  lastname         TEXT,
  email            TEXT,
  company          TEXT,
  address          TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,
  location_source  TEXT,                      -- 'contact' | 'company' | NULL
  last_contacted   TEXT,                      -- ISO
  last_purchase    TEXT,                      -- ISO
  lat              REAL,
  lng              REAL,
  unmapped_reason  TEXT,                      -- set when lat/lng are NULL
  updated_at       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geocode_cache (
  address_key  TEXT PRIMARY KEY,              -- normalized address string
  lat          REAL,
  lng          REAL,
  status       TEXT NOT NULL,                 -- 'ok' | 'not_found'
  formatted    TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  ok           INTEGER,
  summary      TEXT
);
`;

function openDb(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
