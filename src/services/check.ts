import { getDb } from '../db/db.js';
import {
  bufferToIpv6,
  detectIpVersion,
  intToIpv4,
  ipv4ToInt,
  ipv6ToBuffer,
  toBuffer,
} from '../lib/ip.js';

export type ProviderHit = {
  provider_id: string;
  category: string;
  match: string;
};

export type CheckResult = {
  ip: string;
  version: 4 | 6;
  vpn: boolean;
  abuse: boolean;
  tor: boolean;
  flags: string[];
  providers: ProviderHit[];
};

// Categories that are always evaluated and surfaced as top-level booleans on
// the response, regardless of opt-in flags. They answer distinct questions —
// VPN exit, reported-abusive, Tor exit — and callers shouldn't need to
// remember to ask for each one.
const ALWAYS_ON_CATEGORIES = ['vpn', 'abuse', 'tor'] as const;

export async function checkIp(ipStr: string, extraCategories: string[]): Promise<CheckResult> {
  const version = detectIpVersion(ipStr);
  if (version === null) throw new Error(`invalid IP: ${ipStr}`);

  const wanted = new Set<string>([
    ...ALWAYS_ON_CATEGORIES,
    ...extraCategories.map((c) => c.toLowerCase()),
  ]);
  const flags: Record<string, boolean> = {};
  for (const c of ALWAYS_ON_CATEGORIES) flags[c] = false;
  for (const c of extraCategories) flags[c.toLowerCase()] = false;

  const hits: ProviderHit[] = [];
  const db = getDb();

  if (version === 4) {
    const ip = ipv4ToInt(ipStr);
    const rows = await db
      .selectFrom('ip_ranges as r')
      .innerJoin('providers as p', 'p.id', 'r.provider_id')
      .select(['p.id as provider_id', 'p.category as category', 'r.start_ip', 'r.end_ip', 'r.cidr'])
      .where('p.enabled', '=', 1)
      .where('r.start_ip', '<=', ip)
      .where('r.end_ip', '>=', ip)
      .execute();
    for (const row of rows) {
      // Defensive lowercase: createProvider/patchProvider normalize on write,
      // but a hand-edited DB row with mixed case shouldn't silently drop.
      const cat = row.category.toLowerCase();
      if (!wanted.has(cat)) continue;
      flags[cat] = true;
      hits.push({
        provider_id: row.provider_id,
        category: cat,
        match: row.cidr ?? `${intToIpv4(row.start_ip)}-${intToIpv4(row.end_ip)}`,
      });
    }
  } else {
    const ipBuf = ipv6ToBuffer(ipStr);
    const rows = await db
      .selectFrom('ip_ranges_v6 as r')
      .innerJoin('providers as p', 'p.id', 'r.provider_id')
      .select(['p.id as provider_id', 'p.category as category', 'r.start_ip', 'r.end_ip', 'r.cidr'])
      .where('p.enabled', '=', 1)
      .where('r.start_ip', '<=', ipBuf)
      .where('r.end_ip', '>=', ipBuf)
      .execute();
    for (const row of rows) {
      const cat = row.category.toLowerCase();
      if (!wanted.has(cat)) continue;
      flags[cat] = true;
      hits.push({
        provider_id: row.provider_id,
        category: cat,
        // Normalize via toBuffer because D1 returns ArrayBuffer for BLOB
        // columns; better-sqlite3 returns Buffer. Both must end up as Buffer
        // for bufferToIpv6 to index correctly.
        match:
          row.cidr ??
          `${bufferToIpv6(toBuffer(row.start_ip))}-${bufferToIpv6(toBuffer(row.end_ip))}`,
      });
    }
  }

  // flags is the list of categories that *matched*, in stable order:
  // always-on first (vpn, abuse, tor), then any opt-in extras the caller asked
  // about. Deduped — defensive against an extras list with repeats. Empty
  // array means no category hit.
  const matchedFlags: string[] = [];
  const seen = new Set<string>();
  const ordered = [
    ...ALWAYS_ON_CATEGORIES,
    ...extraCategories.map((x) => x.toLowerCase()),
  ];
  for (const c of ordered) {
    if (seen.has(c)) continue;
    seen.add(c);
    if (flags[c]) matchedFlags.push(c);
  }

  return {
    ip: ipStr,
    version,
    vpn: flags.vpn === true,
    abuse: flags.abuse === true,
    tor: flags.tor === true,
    flags: matchedFlags,
    providers: hits,
  };
}
