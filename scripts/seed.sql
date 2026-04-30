-- One-off seed of the 6 default providers. Idempotent (INSERT OR IGNORE) so
-- it's safe to re-run. The Node entry seeds these automatically on startup;
-- Workers users run this once after `wrangler d1 migrations apply novpn`:
--   wrangler d1 execute novpn --remote --file=./scripts/seed.sql

INSERT OR IGNORE INTO providers (id, name, category, enabled, sources, created_at, updated_at)
VALUES (
  'protonvpn', 'ProtonVPN', 'vpn', 1,
  '[{"url":"https://raw.githubusercontent.com/tn3w/ProtonVPN-IPs/master/protonvpn_ips.txt","format":"txt"},{"url":"https://raw.githubusercontent.com/tn3w/ProtonVPN-IPs/master/protonvpn_entry_ips.txt","format":"txt"}]',
  unixepoch(), unixepoch()
);

INSERT OR IGNORE INTO providers (id, name, category, enabled, sources, created_at, updated_at)
VALUES (
  'tunnelbear', 'TunnelBear', 'vpn', 1,
  '[{"url":"https://raw.githubusercontent.com/tn3w/TunnelBear-IPs/master/tunnelbear_ips.txt","format":"txt"}]',
  unixepoch(), unixepoch()
);

INSERT OR IGNORE INTO providers (id, name, category, enabled, sources, created_at, updated_at)
VALUES (
  'nordvpn', 'NordVPN', 'vpn', 1,
  '[{"url":"https://ipapi.is/data/nordvpn-ip-addresses.txt","format":"txt"}]',
  unixepoch(), unixepoch()
);

INSERT OR IGNORE INTO providers (id, name, category, enabled, sources, created_at, updated_at)
VALUES (
  'ipvanish', 'IPVanish', 'vpn', 1,
  '[{"url":"https://ipapi.is/data/ipvanish-ip-addresses.txt","format":"txt"}]',
  unixepoch(), unixepoch()
);

INSERT OR IGNORE INTO providers (id, name, category, enabled, sources, created_at, updated_at)
VALUES (
  'x4bnet', 'X4BNet aggregate', 'vpn', 1,
  '[{"url":"https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt","format":"txt"}]',
  unixepoch(), unixepoch()
);

INSERT OR IGNORE INTO providers (id, name, category, enabled, sources, created_at, updated_at)
VALUES (
  'abuseipdb', 'AbuseIPDB (borestad)', 'abuse', 1,
  '[{"url":"https://raw.githubusercontent.com/borestad/blocklist-abuseipdb/main/abuseipdb-s100-30d.ipv4","format":"txt"}]',
  unixepoch(), unixepoch()
);
