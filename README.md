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

