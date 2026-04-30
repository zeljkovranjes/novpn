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
