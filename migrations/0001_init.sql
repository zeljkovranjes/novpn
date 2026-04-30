-- D1 / SQLite initial schema. Mirrors src/db/migrations/001_init.ts (the
-- Kysely migrator generates the same DDL for the Node runtime).

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'vpn',
  enabled INTEGER NOT NULL DEFAULT 1,
  sources TEXT NOT NULL,
  last_refresh_at INTEGER,
  last_refresh_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_providers_category_enabled ON providers (category, enabled);

CREATE TABLE ip_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  start_ip INTEGER NOT NULL,
  end_ip INTEGER NOT NULL,
  cidr TEXT
);

CREATE INDEX idx_ip_ranges_lookup ON ip_ranges (start_ip, end_ip);
CREATE INDEX idx_ip_ranges_provider ON ip_ranges (provider_id);
