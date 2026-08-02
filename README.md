# Remind Me

Passwordless recurring reminder email service. Delivered by email
(Mailgun everywhere; SMTP on Docker/Node only).

Two first-class deploy targets:

- **Cloudflare Workers** — D1 + KV + cron (free tier friendly)
- **Docker** — SQLite on disk, Compose or `docker run`

Operator config (Mailgun/SMTP, site URL, session/OTP secrets, registration
mode) lives in the database after a one-time setup wizard. Bootstrap env
only needs `INSTANCE_SECRET` (seals encrypted settings) and `SETUP_TOKEN`
(gates the wizard until setup completes).

## Stack

TypeScript · Hono · Drizzle · `rrule` + luxon · Preact + Vite + Tailwind v4 ·
Biome · Vitest · Mailgun · nodemailer (Node/Docker SMTP) ·
`@simplewebauthn` (optional passkeys).

## Prerequisites

- Node 22+
- **Workers:** Cloudflare account; Mailgun (or finish setup with import)
- **Docker:** Docker Engine; Mailgun *or* any SMTP server

## Cloudflare Workers

### One-time Cloudflare resources

```bash
npm install
npx wrangler login
npx wrangler d1 create remindme           # paste database_id into wrangler.toml
npx wrangler kv namespace create KV       # paste id into wrangler.toml
```

Also set in `wrangler.toml` if you fork: Worker `name`, `[vars] APP_NAME`,
`MAILGUN_REGION` (`us`/`eu`), and `web/src/buildInfo.ts` → `GITHUB_REPO`.

Custom domains are attached in the Cloudflare dashboard (not in
`wrangler.toml`).

### Bootstrap secrets

| Secret | Purpose |
| --- | --- |
| `INSTANCE_SECRET` | Seals encrypted `app_settings` (≥16 chars; use a long random hex) |
| `SETUP_TOKEN` | Gates `/api/setup/*` until setup completes (then optional to remove) |

```bash
# Local `wrangler dev`
cp .dev.vars.example .dev.vars   # edit values; never commit .dev.vars

# Production
npx wrangler secret put INSTANCE_SECRET
npx wrangler secret put SETUP_TOKEN
```

`.dev.vars` (local) and `wrangler secret put` (production) are independent —
populate both if you develop and deploy.

Legacy Mailgun / session / `ADMIN_EMAILS` secrets are no longer required.
If they are still present on an old Worker, the app can bridge them into
`app_settings` once, then you can delete them from the dashboard.

### Migrate, run, deploy

```bash
npm run db:migrate:local
npm run db:migrate:remote

npm run dev          # Worker :8787 + Vite :5173 (proxies /api and /r)
npm run deploy       # build SPA → remote D1 migrations → wrangler deploy
```

After deploy, open the site and complete the **setup wizard** (or import an
instance export). Until then, the SPA loads but API routes return
`setup_required`.

If the browser shows **`ECONNREFUSED 127.0.0.1:8787`** in the Vite terminal,
the Worker never bound its port — scroll the **`[worker]`** log: Wrangler
exits when `web/dist` is missing. `npm run dev` runs
`scripts/ensure-web-dist.mjs` before `wrangler dev`; if you start Vite alone,
also run `npm run dev:worker` or `npm run build:web` once after a clean clone.

Manually fire the scheduler in local Wrangler:

```bash
curl 'http://localhost:8787/__scheduled?cron=*/5+*+*+*+*'
```

## Docker

```bash
cp .env.example .env          # set INSTANCE_SECRET + SETUP_TOKEN
docker compose up -d --build  # http://localhost:8080
```

Compose mounts `./data` for the SQLite file. Optional: `TRUST_PROXY`,
`TLS_CERT_PATH` / `TLS_KEY_PATH` for native TLS behind no reverse proxy.

Without Compose:

```bash
npm run docker:build
docker run --rm -p 8080:8080 \
  -e INSTANCE_SECRET=… -e SETUP_TOKEN=… \
  -v remindme-data:/data remindme
```

Local Node (no Docker): set the same env vars, then
`npm run dev:node` (builds the SPA, serves on `PORT` or 8080).

SMTP is available on Docker/Node only; Workers stays Mailgun.

## Setup wizard

On first visit (setup incomplete), enter `SETUP_TOKEN` and either:

1. **Configure** — app name, site origin, mail provider + credentials,
   registration mode, first admin email; or
2. **Import** — paste an instance export (optionally passphrase-wrapped).

Settings are encrypted with `INSTANCE_SECRET`. Admins can later view/edit
them under **Admin → Instance**, export/import, and promote other users.

Admins are `users.is_admin` (set at setup / by an existing admin), not an
env allow-list.

## Day-to-day

```bash
npm run dev          # Workers + SPA
npm run dev:node     # Node/SQLite + built SPA
npm test
npm run lint         # biome (lint:fix to autofix)
npm run typecheck
npm run build
npm run deploy       # Cloudflare
npm run docker:build
```

### Passkeys

Optional. Sign in with OTP → Passkeys section → add one. Sign-in then offers
passkey. Removing all passkeys is safe — OTP still works. WebAuthn needs
HTTPS or `localhost`.

### Mailgun webhooks

Point Mailgun at `<siteOrigin>/webhooks/mailgun` for Permanent Failure,
Temporary Failure, Spam Complaint, and Unsubscribes. The signing key is the
one stored in instance settings (Admin → Instance shows the URL helper).

OTP emails also include a one-click sign-in link (`/r/…`) that expires with
the code.

### Appearance

Header toggle: System / Light / Dark. Color themes (palettes) are under
**Settings → Appearance** (browser `localStorage` only).

## Auto-deploy from `main`

Pushes to `main` run CI (lint, typecheck, tests, SPA/Worker build, Docker
image build). If green, a second job runs `npm run deploy`.

GitHub repo secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers / D1 / KV edit (scoped token) |
| `CLOUDFLARE_ACCOUNT_ID` | Pins the account so wrangler skips `/memberships` |

Optional GitHub Environment `production` for deploy history / reviewers.
See `.github/workflows/ci.yml`.

## Going live — checklist

- `INSTANCE_SECRET` set (not the placeholder) on Workers secrets or Docker `.env`
- Setup wizard completed (Mailgun or SMTP + site origin + first admin)
- DNS / custom domain (Workers dashboard) or reverse proxy (Docker)
- Mailgun domain verified; webhooks → `/webhooks/mailgun` when using Mailgun
- `GET /api/healthz` → `200 {"ok":true}`
- Cron: Workers uses `*/5 * * * *` in `wrangler.toml`; Docker uses `node-cron`

## License

Copyright (C) 2026 Joshua Penman. Released under the [GNU Affero
General Public License v3.0 or later](./LICENSE) (AGPLv3+).

In plain terms:

- **Self-hosting an unmodified copy with your own config** — fine, no
  share-back obligation.
- **Modifying the code and running it** so others can use it over a
  network — you must offer users the modified source under AGPL.
- **Redistributing** — keep the LICENSE and offer source.
- **No warranty.**

Authoritative text: [AGPLv3 on gnu.org](https://www.gnu.org/licenses/agpl-3.0.html).
