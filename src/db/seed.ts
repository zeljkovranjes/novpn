import { getDb, now } from './db.js';
import type { SourceConfig } from './schema.js';

type Seed = {
  id: string;
  name: string;
  category: string;
  sources: Array<Pick<SourceConfig, 'url' | 'format'>>;
};

const DEFAULT_PROVIDERS: Seed[] = [
  {
    id: 'protonvpn',
    name: 'ProtonVPN',
    category: 'vpn',
    sources: [
      { url: 'https://raw.githubusercontent.com/tn3w/ProtonVPN-IPs/master/protonvpn_ips.txt', format: 'txt' },
      { url: 'https://raw.githubusercontent.com/tn3w/ProtonVPN-IPs/master/protonvpn_entry_ips.txt', format: 'txt' },
    ],
  },
  {
    id: 'tunnelbear',
    name: 'TunnelBear',
    category: 'vpn',
    sources: [
      { url: 'https://raw.githubusercontent.com/tn3w/TunnelBear-IPs/master/tunnelbear_ips.txt', format: 'txt' },
    ],
  },
  {
    id: 'nordvpn',
    name: 'NordVPN',
    category: 'vpn',
    sources: [
      { url: 'https://ipapi.is/data/nordvpn-ip-addresses.txt', format: 'txt' },
    ],
  },
  {
    id: 'ipvanish',
    name: 'IPVanish',
    category: 'vpn',
    sources: [
      { url: 'https://ipapi.is/data/ipvanish-ip-addresses.txt', format: 'txt' },
    ],
  },
  {
    id: 'x4bnet',
    name: 'X4BNet aggregate',
    category: 'vpn',
    sources: [
      { url: 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt', format: 'txt' },
    ],
  },
  {
    id: 'abuseipdb',
    name: 'AbuseIPDB (borestad)',
    category: 'abuse',
    sources: [
      {
        url: 'https://raw.githubusercontent.com/borestad/blocklist-abuseipdb/main/abuseipdb-s100-30d.ipv4',
        format: 'txt',
      },
    ],
  },
  {
    id: 'mullvad',
    name: 'Mullvad',
    category: 'vpn',
    sources: [
      // Returns nested JSON with wireguard.relays[*].ipv4_addr_in / ipv6_addr_in.
      // Custom parser pulls both v4 and v6 host addresses.
      { url: 'https://api.mullvad.net/app/v1/relays', format: 'mullvad-relays' },
    ],
  },
  {
    id: 'tor',
    name: 'Tor exit nodes',
    category: 'tor',
    sources: [
      // dan.me.uk publishes a flat newline-delimited exit list. Rate-limited
      // to once per 30 minutes per source IP — fine for daily cron.
      { url: 'https://www.dan.me.uk/torlist/?exit', format: 'txt' },
    ],
  },
  {
    id: 'windscribe',
    name: 'Windscribe',
    category: 'vpn',
    sources: [
      { url: 'https://raw.githubusercontent.com/tn3w/Windscribe-IPs/master/windscribe_ips.txt', format: 'txt' },
    ],
  },
  {
    id: 'airvpn',
    name: 'AirVPN',
    category: 'vpn',
    sources: [
      // Live status endpoint, includes both v4 (ip_v4_in1..4) and v6
      // (ip_v6_in1..2) entry addresses per server.
      { url: 'https://airvpn.org/api/status/?format=json', format: 'airvpn-status' },
    ],
  },
  {
    id: 'ivpn',
    name: 'IVPN',
    category: 'vpn',
    sources: [
      // wireguard[].hosts[].host + .v2ray + openvpn[].hosts[].host. v4 only —
      // their published v6 is internal ULA, not exit space.
      { url: 'https://api.ivpn.net/v5/servers.json', format: 'ivpn-servers' },
    ],
  },
];

export async function seedIfEmpty(): Promise<{ inserted: string[] }> {
  const db = getDb();
  const ts = now();
  const rows = DEFAULT_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    enabled: 1,
    sources: JSON.stringify(p.sources.map((s): SourceConfig => ({ url: s.url, format: s.format }))),
    last_refresh_at: null,
    last_refresh_status: null,
    created_at: ts,
    updated_at: ts,
  }));

  // Inside a transaction so a concurrent startup can't race the
  // check-then-insert and end up with a PK conflict on the multi-row insert.
  // `onConflict … doNothing` makes the per-id insert idempotent — the second
  // boot is a no-op rather than a crash.
  const inserted = await db.transaction().execute(async (trx) => {
    const out: string[] = [];
    for (const row of rows) {
      const result = await trx
        .insertInto('providers')
        .values(row)
        .onConflict((oc) => oc.column('id').doNothing())
        .executeTakeFirst();
      if (Number(result.numInsertedOrUpdatedRows ?? 0) > 0) {
        out.push(row.id);
      }
    }
    return out;
  });

  return { inserted };
}
