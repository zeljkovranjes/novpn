-- IPv6 range table — BLOB columns so SQLite's binary memcmp gives the
-- correct numeric ordering for big-endian-encoded IPv6 addresses.

CREATE TABLE ip_ranges_v6 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id TEXT NOT NULL REFERENCES providers (id) ON DELETE CASCADE,
  start_ip BLOB NOT NULL,
  end_ip BLOB NOT NULL,
  cidr TEXT
);

CREATE INDEX idx_ip_ranges_v6_lookup ON ip_ranges_v6 (start_ip, end_ip);
CREATE INDEX idx_ip_ranges_v6_provider ON ip_ranges_v6 (provider_id);
