// External IP-intelligence enrichment. Called only when our local DB has no
// hit. Tries the providers in order; if one fails (network error, non-2xx,
// timeout, parse error) we move on to the next. If all fail, we shrug and
// return nothing — the local result stands.

export type ExternalSignals = {
  vpn?: boolean;
  abuse?: boolean;
  tor?: boolean;
  proxy?: boolean;
  // The provider whose response we ended up using, for attribution.
  source?: string;
};

const FETCH_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 5_000;

// Per-isolate in-memory cache. Workers + Node both fine; nothing shared.
const cache = new Map<string, { signals: ExternalSignals; expiresAt: number }>();

function cacheGet(ip: string): ExternalSignals | null {
  const hit = cache.get(ip);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(ip);
    return null;
  }
  return hit.signals;
}

function cacheSet(ip: string, signals: ExternalSignals): void {
  // Drop oldest entry if the cap is exceeded — Map preserves insertion order.
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(ip, { signals, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'novpn/0.1 (+https://github.com/zeljkovranjes/novpn)',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ip.nc.gy/json?ip=… — proxy/vpn/tor under `proxy.{is_*}`, no is_abuser.
async function fromNcGy(ip: string): Promise<ExternalSignals | null> {
  type Resp = { proxy?: { is_vpn?: boolean; is_tor?: boolean; is_proxy?: boolean } };
  const d = await fetchJson<Resp>(`https://ip.nc.gy/json?ip=${encodeURIComponent(ip)}`);
  if (!d) return null;
  const p = d.proxy ?? {};
  return {
    vpn: p.is_vpn === true ? true : undefined,
    tor: p.is_tor === true ? true : undefined,
    proxy: p.is_proxy === true ? true : undefined,
    source: 'ip.nc.gy',
  };
}

// api.ipapi.is/?ip=… — top-level is_vpn/is_tor/is_proxy/is_abuser.
async function fromIpapiIs(ip: string): Promise<ExternalSignals | null> {
  type Resp = {
    is_vpn?: boolean;
    is_tor?: boolean;
    is_proxy?: boolean;
    is_abuser?: boolean;
  };
  const d = await fetchJson<Resp>(`https://api.ipapi.is/?ip=${encodeURIComponent(ip)}`);
  if (!d) return null;
  return {
    vpn: d.is_vpn === true ? true : undefined,
    tor: d.is_tor === true ? true : undefined,
    proxy: d.is_proxy === true ? true : undefined,
    abuse: d.is_abuser === true ? true : undefined,
    source: 'ipapi.is',
  };
}

export async function enrichExternal(ip: string): Promise<ExternalSignals> {
  const cached = cacheGet(ip);
  if (cached) return cached;

  // Sequential fallback — if one provider fails, try the next. If all fail,
  // we cache an empty result so we don't keep retrying for CACHE_TTL_MS.
  let signals: ExternalSignals = {};
  const tryOne = async (fn: (ip: string) => Promise<ExternalSignals | null>) => {
    const r = await fn(ip);
    if (r) signals = r;
    return r != null;
  };

  if (!(await tryOne(fromNcGy))) await tryOne(fromIpapiIs);

  cacheSet(ip, signals);
  return signals;
}
