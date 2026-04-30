# novpn

A self-hosted "is this IP a VPN?" lookup service. Pulls VPN exit-IP lists from
public sources, normalizes them into a SQLite-flavored database, and answers
point-in-CIDR queries over a small HTTP API. Optional opt-in for non-VPN
categories like AbuseIPDB.


Runs on **two backends from one codebase**, auto-detected via
`navigator.userAgent === 'Cloudflare-Workers'`:

- **Node + Hono + Kysely + better-sqlite3** — `pnpm dev` (entry: `src/index.ts`)
- **Cloudflare Workers + Hono + Kysely + D1** — `pnpm wrangler:dev` (entry: `src/worker.ts`)

Routes, services, the URL guard, the dynamic-provider model — all of it is shared.
Only DB initialization and the cron mechanism (node-cron vs CF Cron Triggers) differ.


## Node quickstart

```bash
pnpm install
cp .env.example .env       # edit if you want
pnpm dev                   # migrates, seeds, starts on :3000
```

On first boot, the Node entry:

1. Runs Kysely migrations (creates `data/novpn.sqlite`).
2. Seeds 6 default providers (5 VPN + 1 abuse).
3. Triggers a one-shot refresh of every provider that has never been fetched.
4. Schedules a daily refresh at 03:00 (configurable via `REFRESH_CRON`).

Refreshing all six default sources takes ~5 seconds on a warm network.


## Cloudflare Workers quickstart

```bash
pnpm install
pnpm wrangler:d1:create                            # one time — creates the D1 db, prints database_id
# paste the database_id into wrangler.toml

pnpm exec wrangler d1 migrations apply novpn       # local dev D1
pnpm exec wrangler d1 execute novpn --file=./scripts/seed.sql

pnpm wrangler:dev                                  # local dev on :8787
```

Deploying to production:

```bash
pnpm exec wrangler d1 migrations apply novpn --remote
pnpm exec wrangler d1 execute novpn --remote --file=./scripts/seed.sql
pnpm exec wrangler secret put API_SECRET           # optional but recommended
pnpm wrangler:deploy
```

The Cloudflare Cron Trigger declared in `wrangler.toml` (`0 3 * * *`) calls
the same `refreshAllProviders` as the Node scheduler. Manual refresh works
the same via `POST /v1/refresh` once `API_SECRET` is configured.
## Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `data/novpn.sqlite` | SQLite file |
| `API_SECRET` | unset | Auth secret. See **Auth** below — admin endpoints always require it; lookup endpoints require it only when set. |
| `REFRESH_CRON` | `0 3 * * *` | 5-field cron in server timezone |
| `DISABLE_CRON` | `0` | Set `1` to disable the in-process scheduler (manual refresh still works) |
| `DISABLE_REFRESH_ON_START` | `0` | Set `1` to skip the boot-time refresh of never-fetched providers |
| `FETCH_TIMEOUT_MS` | `30000` | Per-source HTTP timeout |
| `BATCH_CHECK_MAX` | `1000` | Max IPs in `POST /v1/check/batch` |

## Auth

There are two tiers, controlled by the `API_SECRET` env var:

| Endpoint group | `API_SECRET` unset | `API_SECRET` set |
|---|---|---|
| `/`, `/health` | open | open |
| `/v1/check*`, `/v1/categories`, `/v1/stats` | open | required |
| `/v1/providers*`, `/v1/refresh` | **503** (admin disabled) | required |

Admin endpoints (provider CRUD, manual refresh) always require an `API_SECRET`.
If the env var is unset, those endpoints return `503 admin_disabled` — the operator
can still manage providers via `pnpm refresh` from the host. Lookup endpoints are
public until you set a secret, then they require `Authorization: Bearer <secret>`.

## API

### Lookup

Both IPv4 and IPv6 are accepted (any canonical form: `2001:db8::1`, `::1`, IPv4-mapped, etc.).

```
GET  /v1/check?ip=1.2.3.4
GET  /v1/check?ip=2001:db8::1
GET  /v1/check?ip=1.2.3.4&abuse=true&tor=true
GET  /v1/check/me                          # uses cf-connecting-ip / x-forwarded-for (see "Trusted proxy" below)
POST /v1/check/batch
     { "ips": ["1.2.3.4", "2001:db8::1"], "abuse": true }
```

Response:

```json
{
  "ip": "103.107.197.78",
  "version": 4,
  "vpn": true,
  "flags": { "vpn": true, "abuse": false },
  "providers": [
    { "provider_id": "nordvpn", "category": "vpn", "match": "103.107.197.76/32" }
  ]
}
```

`vpn` is always present and always checked. Every other category (abuse, tor, …)
is **opt-in** via a matching boolean flag (`?abuse=true` in query, or `"abuse": true`
in the JSON body). The set of valid flags is whatever non-`vpn` categories
currently exist in the providers table — adding a provider with `category: "tor"`
makes `?tor=true` work immediately, no code change.

`?all=true` enables every well-known category at once (`abuse`, `tor`, `proxy`,
`datacenter`, `hosting`).

### Providers (admin)

```
GET    /v1/providers
GET    /v1/providers/:id
POST   /v1/providers
PATCH  /v1/providers/:id
DELETE /v1/providers/:id
POST   /v1/providers/:id/refresh
POST   /v1/refresh
```

Create a custom provider:

```bash
curl -X POST http://localhost:3000/v1/providers \
  -H 'authorization: Bearer $API_SECRET' \
  -H 'content-type: application/json' \
  -d '{
        "id": "myvpn",
        "name": "My VPN",
        "category": "vpn",
        "sources": [
          { "url": "https://example.com/ips.txt",   "format": "txt" },
          { "url": "https://example.com/ips.json",  "format": "json-array" }
        ]
      }'
```

The server kicks off a background refresh immediately on create or on a sources-change
patch. `GET /v1/providers/:id` returns per-source state (last status, last count, etag,
last error) so you can debug a flaky URL.

Provider IDs are `[a-z0-9][a-z0-9_-]{0,63}` (case-insensitive). `category` is a
free-form string; `vpn` is the only category that's checked by default.

### Source formats

| Format | Looks like | Use for |
|---|---|---|
| `txt` | newline-delimited; `#` comments and blank lines OK; supports single IP, CIDR, and `start-end` ranges (v4 only) | almost every public list |
| `json-array` | `["1.2.3.0/24", "2001:db8::/32"]` | sources that ship a JSON array of strings |

Each line/entry can be IPv4 or IPv6 — single host, CIDR, or `start-end` (v4 only).
A single source can mix versions; novpn splits them into separate tables transparently.

For repos that ship multiple files (e.g. ProtonVPN ships `_logicals.json`, `_ips.json`,
`_ips.txt`, …), point at the simple `*_ips.txt` flavor. Complex API-dump files like
`protonvpn_logicals.json` are out of scope.

> **About the default seed:** the six default providers happen to ship IPv4-only
> lists upstream. IPv6 lookup is fully wired and ready — add a custom provider
> with v6 sources via `POST /v1/providers` and the rest is automatic.

### Meta

```
GET /v1/categories     # categories in use, derived from providers
GET /v1/stats          # total ranges + per-provider state
GET /health            # always public, no auth
GET /                  # service info, includes auth_required hint
```

## Default providers

Seeded once on first migration. Edit or disable via the API; nothing here is special-cased.

| ID | Category | Source |
|---|---|---|
| `protonvpn` | vpn | tn3w/ProtonVPN-IPs (`protonvpn_ips.txt`, `protonvpn_entry_ips.txt`) |
| `tunnelbear` | vpn | tn3w/TunnelBear-IPs (`tunnelbear_ips.txt`) |
| `nordvpn` | vpn | ipapi.is `nordvpn-ip-addresses.txt` |
| `ipvanish` | vpn | ipapi.is `ipvanish-ip-addresses.txt` |
| `x4bnet` | vpn | X4BNet/lists_vpn (`output/vpn/ipv4.txt`) — aggregates many providers |
| `abuseipdb` | abuse | borestad/blocklist-abuseipdb (`abuseipdb-s100-30d.ipv4`) — high-confidence, last 30 days |

Pomerium/vpnlist is not included by default — its YAML format is unsupported in v1
and X4BNet covers similar ground.

## Refresh behavior

- **Schedule:** `REFRESH_CRON` (default daily at 03:00) with a random 0–60s jitter.
- **Conditional fetch:** every source remembers its `ETag` and `Last-Modified`; the
  next refresh sends `If-None-Match` / `If-Modified-Since` and skips parsing on `304`.
- **Tolerant:** a failed source marks itself `failed` but doesn't blow up the
  provider. A provider with at least one OK source ends up `partial`; everything
  failing yields `failed`.
- **Atomic per-provider:** new ranges replace the provider's old ranges in a single
  transaction, so reads never see a half-built index.
- **Merging:** adjacent and overlapping ranges from a single provider are merged
  before write — typical input shrinks ~10–15%.
- **Manual:** `pnpm refresh` (all) or `pnpm refresh <provider-id>` (one) for ops use.

