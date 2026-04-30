# novpn

Self-hosted VPN detection service. Pulls VPN exit-IP lists from public sources,
normalizes them into SQLite or D1, and answers point-in-CIDR queries over a
small HTTP API.

## Features

- IPv4 and IPv6 lookups against merged provider ranges.
- Pluggable providers — add, edit, or remove sources at runtime via the API.
- Opt-in non-VPN categories (`?abuse=true`, `?tor=true`, …) plus an `?all=true` flag.
- Daily refresh cron with `ETag` / `Last-Modified` conditional fetches.
- Same codebase runs on Node (better-sqlite3) or Cloudflare Workers (D1), auto-detected at runtime.
- Optional bearer auth (`API_SECRET`) that always gates admin endpoints and gates lookup endpoints when set.

## Installation

### Node

```bash
pnpm install
cp .env.example .env
pnpm dev
```

First boot runs migrations, seeds the 6 default providers (5 VPN + AbuseIPDB),
triggers a one-shot refresh, and starts the daily cron.

### Cloudflare Workers

```bash
pnpm install
pnpm wrangler:d1:create
# paste the printed database_id into wrangler.toml

pnpm exec wrangler d1 migrations apply novpn
pnpm exec wrangler d1 execute novpn --file=./scripts/seed.sql
pnpm wrangler:dev
```

Deploy:

```bash
pnpm exec wrangler d1 migrations apply novpn --remote
pnpm exec wrangler d1 execute novpn --remote --file=./scripts/seed.sql
pnpm exec wrangler secret put API_SECRET   # optional
pnpm wrangler:deploy
```

## Usage

```bash
# Single lookup (IPv4 or IPv6)
curl 'http://localhost:3000/v1/check?ip=1.2.3.4'
curl 'http://localhost:3000/v1/check?ip=2001:db8::1&abuse=true'

# Use the request's client IP (only meaningful behind a trusted proxy)
curl http://localhost:3000/v1/check/me

# Batch
curl -X POST http://localhost:3000/v1/check/batch \
  -H 'content-type: application/json' \
  -d '{"ips":["1.2.3.4","2001:db8::1"],"abuse":true}'

# Add a custom provider (admin)
curl -X POST http://localhost:3000/v1/providers \
  -H "authorization: Bearer $API_SECRET" \
  -H 'content-type: application/json' \
  -d '{"id":"myvpn","name":"My VPN","sources":[
        {"url":"https://example.com/ips.txt","format":"txt"}
      ]}'

# Refresh everything
curl -X POST http://localhost:3000/v1/refresh \
  -H "authorization: Bearer $API_SECRET"
```

Response:

```json
{
  "ip": "1.2.3.4",
  "version": 4,
  "vpn": true,
  "abuse": false,
  "tor": false,
  "flags": { "vpn": true, "abuse": false, "tor": false },
  "providers": [
    { "provider_id": "nordvpn", "category": "vpn", "match": "1.2.3.0/24" }
  ]
}
```

`vpn`, `abuse`, and `tor` are always evaluated and returned as top-level
booleans — they answer different questions and an IP can be one without
being the others.

Endpoints:

```
GET    /                              service info
GET    /health                        always public
GET    /v1/check?ip=…                 single lookup
GET    /v1/check/me                   client IP from cf-connecting-ip / x-forwarded-for
POST   /v1/check/batch                batch lookup
GET    /v1/categories                 categories from the providers table
GET    /v1/stats                      totals + per-provider range counts
GET    /v1/providers                  list (admin)
GET    /v1/providers/:id              show (admin)
POST   /v1/providers                  create (admin)
PATCH  /v1/providers/:id              update (admin)
DELETE /v1/providers/:id              delete (admin)
POST   /v1/providers/:id/refresh      refresh one (admin)
POST   /v1/refresh                    refresh all (admin)
```

Source formats: `txt` (newline-delimited; `#` comments; single IP, CIDR, or
`start-end` v4 range) and `json-array` (`["1.2.3.0/24", "2001:db8::/32"]`).

## Configuration

Node uses env vars (see `.env.example`). Workers reads bindings from
`wrangler.toml` and secrets from `wrangler secret put`.

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port (Node) |
| `DATABASE_PATH` | `data/novpn.sqlite` | SQLite file (Node) |
| `API_SECRET` | unset | Bearer secret. Admin endpoints always require it; lookups require it only when set. |
| `REFRESH_CRON` | `0 3 * * *` | 5-field cron, server timezone (Node) |
| `DISABLE_CRON` | `0` | Set `1` to disable the in-process scheduler |
| `DISABLE_REFRESH_ON_START` | `0` | Skip the boot-time refresh of never-fetched providers |
| `FETCH_TIMEOUT_MS` | `30000` | Per-source fetch timeout |
| `BATCH_CHECK_MAX` | `1000` | Max IPs per `POST /v1/check/batch` |

On Workers, the cron is in `wrangler.toml` under `[triggers] crons`, not in env.

`/v1/check/me` reads `cf-connecting-ip`, `cf-connecting-ipv6`, `cf-pseudo-ipv4`,
`true-client-ip`, `fastly-client-ip`, `fly-client-ip`, `x-vercel-forwarded-for`,
`x-azure-clientip`, `x-azure-socketip`, `x-appengine-user-ip`, `x-real-ip`,
`x-client-ip`, `x-cluster-client-ip`, RFC 7239 `Forwarded`, then `x-forwarded-for`.
Only meaningful behind a reverse proxy that strips/overwrites those headers.

## Requirements

- Node `>=20` (`.nvmrc` pins `20`)
- pnpm
- For the Workers path: a Cloudflare account and `wrangler`

## License

[TODO: no license file in source]
