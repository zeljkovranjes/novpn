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
