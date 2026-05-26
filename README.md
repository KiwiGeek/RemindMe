# Remind Me

Passwordless recurring reminder email service. Runs on Cloudflare Workers (free
tier) and delivers via Mailgun.

See [`PLAN.md`](./PLAN.md) for the design and [`AGENTS.md`](./AGENTS.md) for
contributor conventions.

## Stack

TypeScript · Hono · Cloudflare D1 + Drizzle · Workers KV · Workers Cron · Vite +
Preact + Tailwind v4 · Biome · Vitest (Workers pool) · Mailgun.

## Prerequisites

- Node 20+
- A Cloudflare account (free tier is fine). To use a custom domain you'll
  need that domain set up as an active zone on the same account.
- A Mailgun account with your sending domain verified — SPF, DKIM, and
  the tracking CNAME records all green in the Mailgun dashboard.
  Mailgun's free / "Foundation" tier is sufficient.
- `wrangler` and `gh` available on PATH (`wrangler` is installed as a
  project devDependency; `gh` is optional, only used for repo admin like
  flipping visibility).

## Forking this for your own deploy

Anything operator-specific (your domain, your Mailgun account, your
admin allow-list) lives outside the committed code. `wrangler.toml`
only carries non-sensitive defaults; everything else is set via
`wrangler secret put` for production and `.dev.vars` for local dev.

Things to change before the first `wrangler deploy`:

| File | Setting | What to change |
| --- | --- | --- |
| `wrangler.toml` | `name` | Your Worker name (DNS-safe). Defaults to `remindme`. |
| `wrangler.toml` | `[vars] APP_NAME` | Whatever you want the SPA to call itself. |
| `wrangler.toml` | `[vars] MAILGUN_REGION` | `us` or `eu` — must match your Mailgun account region. |
| `wrangler.toml` | `[[d1_databases]] database_id` | The id `wrangler d1 create` returned for *your* D1. |
| `wrangler.toml` | `[[kv_namespaces]] id` | The id `wrangler kv namespace create` returned for *your* KV. |
| `web/src/buildInfo.ts` | `GITHUB_REPO` | `your-username/your-repo`, so the sign-in footer's commit link points at your fork. |

These values are populated via `wrangler secret put` (see [First-time
setup](#first-time-setup)) and `.dev.vars` for local dev — never
checked into the repo:

| Secret | Used for |
| --- | --- |
| `SITE_ORIGIN` | Public URL of the Worker (e.g. `https://your-domain`). Used in email links + CSRF checks. |
| `MAILGUN_DOMAIN` | Your verified Mailgun sending domain. |
| `MAILGUN_FROM` | Envelope sender, e.g. `Remind Me <reminders@your-domain>`. |
| `MAILGUN_REPLY_TO` | Reply-to address (we discard replies). |
| `ADMIN_EMAILS` | Comma-separated, case-insensitive admin allow-list. |
| `MAILGUN_API_KEY` | Mailgun sending API key. |
| `MAILGUN_SIGNING_KEY` | Mailgun HTTP webhook signing key. |
| `SESSION_SECRET` | HMAC key for session cookies. |
| `OTP_PEPPER` | Hash pepper for stored OTPs. |
| `ACTION_TOKEN_SECRET` | HMAC key for one-click email action tokens. |

For a custom domain, attach it to the Worker via the Cloudflare
dashboard (**Workers & Pages → your-worker → Settings → Domains &
Routes → Add custom domain**); the repo intentionally doesn't pin a
domain in `wrangler.toml`. If you skip this step the Worker is still
reachable at `<name>.<your-subdomain>.workers.dev`.

## First-time setup

```bash
npm install

# Provision Cloudflare resources (one-off).
npx wrangler login
npx wrangler d1 create remindme           # paste the id into wrangler.toml
npx wrangler kv namespace create KV       # paste the id into wrangler.toml

# Apply migrations to local + remote D1.
npm run db:migrate:local
npm run db:migrate:remote

# Local-only secrets for `wrangler dev`.
cp .dev.vars.example .dev.vars            # then edit values

# Production secrets (one-off per environment).
npx wrangler secret put SITE_ORIGIN
npx wrangler secret put MAILGUN_DOMAIN
npx wrangler secret put MAILGUN_FROM
npx wrangler secret put MAILGUN_REPLY_TO
npx wrangler secret put ADMIN_EMAILS
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_SIGNING_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OTP_PEPPER
npx wrangler secret put ACTION_TOKEN_SECRET
```

> **Important:** `.dev.vars` (local) and `wrangler secret put` (production)
> are independent stores. Setting a production secret does **not** make it
> available to `wrangler dev`, and vice versa. You need to populate both
> for any secret you want to use in both environments. The Worker logs a
> loud warning on first request if any required secret is missing or still
> set to the placeholder from `.dev.vars.example`.

## Day-to-day

```bash
npm run dev          # runs Worker (8787) + Vite SPA (5173) concurrently
npm test             # Vitest with Workers pool
npm run lint         # Biome (use lint:fix to autofix)
npm run typecheck    # tsc on Worker + SPA
npm run build        # build SPA then dry-run Worker bundle
npm run deploy       # build SPA + apply remote D1 migrations + wrangler deploy
```

`npm run deploy` always applies any pending D1 migrations to the
production database *before* uploading the new Worker code, so a deploy
can never reference a table the production D1 doesn't have yet. The
migration step is a no-op when there's nothing to apply.

In dev, the Vite server proxies `/api/*` and `/r/*` to the Worker so the SPA
talks to the same origin as in production.

### Passkeys

Passkeys are optional. To opt in:

1. Sign in normally with email OTP.
2. Scroll to the **Passkeys** section on the dashboard.
3. Click **+ Add a passkey** and follow your browser's prompt.

After that, the sign-in screen will offer a "Sign in with a passkey"
button. Removing all passkeys is safe — email OTP keeps working.

Implementation notes:
- WebAuthn requires HTTPS *or* `localhost`. Plain `http://` on any other
  hostname is rejected with a 400.
- Authentication uses discoverable credentials, so no email is needed at
  sign-in time; the browser/OS surfaces the passkeys it has for the
  current origin and the server looks up the user from the credential.
- We cap users at 10 passkeys to bound spam from misbehaving extensions.

### Granting admin access

The admin allow-list is the `ADMIN_EMAILS` Cloudflare secret — a
comma-separated, case-insensitive list of email addresses. There is no
DB-stored admin flag on purpose: escalating to admin requires
re-setting that secret, which in turn requires already controlling the
deploy account.

To add or remove an admin:

```bash
npx wrangler secret put ADMIN_EMAILS
# paste the new comma-separated list when prompted
```

Update `.dev.vars` to match locally. Affected accounts pick up the new
role on their next `GET /api/me`.

### Mailgun webhook setup

Bounce/complaint handling requires Mailgun to POST events to the Worker.
Once deployed:

1. Mailgun dashboard → **Sending → Webhooks** → pick your sending
   domain.
2. For each of these events, set the URL to
   `<SITE_ORIGIN>/webhooks/mailgun` (e.g.
   `https://your-domain/webhooks/mailgun`):
   - **Permanent Failure** (hard bounce → suspend)
   - **Temporary Failure** (soft bounce → audit-only)
   - **Spam Complaint** (suspend)
   - **Unsubscribes** (suspend)
3. Confirm `MAILGUN_SIGNING_KEY` matches the **HTTP webhook signing key**
   shown on the same dashboard page. It's set via
   `wrangler secret put MAILGUN_SIGNING_KEY` (see first-time setup).

Mailgun retries 4xx/5xx for up to 8 hours, so it's safe to deploy the
secret rotation and the worker at the same time — any in-flight retries
will simply succeed on the next attempt. Redeliveries are deduped by
the per-delivery `token` in KV for 24h, so they're a no-op after the
first successful processing.

To verify locally without Mailgun, you can send a hand-signed event
against `wrangler dev`:

```bash
node -e '
const ts = Math.floor(Date.now() / 1000);
const tok = "local-" + Math.random();
const k = process.env.MAILGUN_SIGNING_KEY;
require("crypto").createHmac("sha256", k).update(ts + tok).digest("hex");
console.log({ ts, tok, sig: require("crypto").createHmac("sha256", k).update(ts + tok).digest("hex") });
'
```

…and POST the resulting envelope to `http://localhost:8787/webhooks/mailgun`.
A bad signature returns `401`; a valid one returns `200` with what
action was taken.

### Manually firing a scheduler tick

`wrangler dev` is started with `--test-scheduled`, which exposes
`GET /__scheduled` on the Worker port (8787). Hit it to run the cron handler
exactly as Cloudflare would:

```bash
curl 'http://localhost:8787/__scheduled?cron=*/5+*+*+*+*'
```

The `cron=` query is optional when there's only one schedule. The handler
runs the real Mailgun send for any due reminder, so make sure
`MAILGUN_API_KEY` in `.dev.vars` is the real key (not the placeholder) if
you want emails to actually land.

The cron handler also prunes `reminder_fires` and `audit_log` rows
older than 30 days. The prune runs *after* the send tick and is wrapped
in its own try/catch, so a failure there can never block a send. See
`src/lib/retention.ts`.

## Auto-deploy from `main`

Every push to `main` runs CI (lint + typecheck + tests + build) and, if
that job is green, runs the deploy job — same steps as `npm run deploy`
locally (build SPA → apply remote D1 migrations → `wrangler deploy`).
Concurrency is scoped per-job: a second push to `main` cancels an
in-flight check but **never** an in-flight deploy, so a half-applied
migration or a half-uploaded Worker version isn't possible. Deploys
queue and run in order.

### One-time secret setup

The deploy job needs two GitHub repo secrets:

| Secret | Value | Where to find it |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | A custom API token (see below) | Cloudflare dashboard → **My Profile → API Tokens** |
| `CLOUDFLARE_ACCOUNT_ID` | 32-char hex string | Cloudflare dashboard home → right sidebar |

1. Create the API token at **My Profile → API Tokens → Create Token →
   Custom token**. Permissions (all *Edit* unless noted):
   - **Account** · Workers Scripts · Edit
   - **Account** · D1 · Edit
   - **Account** · Workers KV Storage · Edit
   - **Account** · Account Settings · Read
   - **User** · User Details · Read
   - **Zone** · Workers Routes · Edit (only needed if you ever rebind
     the custom domain; safe to include)

   Scope the token to your single account and zone so a leak is bounded.

   > **Why we set `CLOUDFLARE_ACCOUNT_ID` instead of granting `User →
   > Memberships → Read`:** without an account ID, wrangler probes
   > `/memberships` to discover which account to deploy to, and the
   > memberships endpoint needs its own token permission. Pinning the
   > account ID via env var lets wrangler skip the probe entirely and
   > keeps the token scoped to just what it needs to write.

2. GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret**. Add both `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.

3. (Optional) Repo → **Settings → Environments → New environment →
   `production`**. The workflow already references this environment so
   deploys show up in the repo's Environments sidebar with history.
   Adding a required reviewer here turns auto-deploy into "deploy on
   approval" without any workflow change.

After both secrets exist, the next push to `main` deploys automatically.
If you ever need to ship from a feature branch (e.g. for a hotfix that
hasn't been merged), `npm run deploy` from your laptop still works
exactly as before — auto-deploy is additive, not a replacement.

## Theme (light / dark)

The toggle in the page header cycles between **System** (follows the
OS), **Light**, and **Dark**. The choice persists in `localStorage`.
An inline script in `web/index.html` applies the right class before
React mounts so there's no flash of the wrong theme on first paint; see
`web/src/hooks/useTheme.ts` for the runtime side.

## Going live — pre-flight checklist

Run through this list before announcing the service. Everything is
also covered in detail elsewhere in this README; this section is the
short version to make sure nothing was missed.

- **DNS**: your custom domain is attached to the Worker in the
  Cloudflare dashboard (**Workers & Pages → your-worker → Settings →
  Domains & Routes**). Cloudflare provisions DNS + SSL automatically
  for any zone on the same account. After `npm run deploy`, hit
  `<SITE_ORIGIN>/api/healthz` — should return `200 {"ok":true}`.
- **Mailgun sending domain** verified, tracking records in place,
  "EU vs US" region matches `MAILGUN_REGION` in `wrangler.toml`.
- **Secrets** present in production (set via `wrangler secret put`):
  `SITE_ORIGIN`, `MAILGUN_DOMAIN`, `MAILGUN_FROM`, `MAILGUN_REPLY_TO`,
  `ADMIN_EMAILS`, `MAILGUN_API_KEY`, `MAILGUN_SIGNING_KEY`,
  `SESSION_SECRET`, `OTP_PEPPER`, `ACTION_TOKEN_SECRET`. The Worker
  logs a loud warning on first request if any are still set to the
  `.dev.vars.example` placeholder values.
- **Mailgun webhooks** point at `<SITE_ORIGIN>/webhooks/mailgun` for
  **Permanent Failure**, **Temporary Failure**, **Spam Complaint**,
  and **Unsubscribes**. See [Mailgun webhook
  setup](#mailgun-webhook-setup).
- **Admin emails**: the `ADMIN_EMAILS` secret reflects the real
  operator list (CSV, case-insensitive). Changes need a redeploy or a
  fresh `wrangler secret put ADMIN_EMAILS`.
- **Cron trigger**: `wrangler.toml` declares `*/5 * * * *`, which is
  Cloudflare's free-plan minimum. The scheduler looks 6 minutes ahead so
  emails arrive on time or slightly early, never late.
- **CI** (`.github/workflows/ci.yml`) runs lint + typecheck + tests +
  build on every push to `main` and every PR. **Pushes to `main` also
  auto-deploy** (in a second job that only runs if the check job is
  green). See [Auto-deploy from `main`](#auto-deploy-from-main) for the
  one-time secret setup; until that secret exists the deploy step will
  fail loudly but the check job still gates merges as before.

## Layout

See [`AGENTS.md`](./AGENTS.md#repository-layout-target).

## License

Copyright (C) 2026 Joshua Penman. Released under the [GNU Affero
General Public License v3.0 or later](./LICENSE) (AGPLv3+).

In plain terms:

- **Self-hosting an unmodified copy with your own config** (Mailgun
  domain, admin emails, etc.) — go for it, no obligation back.
- **Modifying the code and running it** so other people can interact
  with it over a network — you must offer your users access to the
  modified source under the same license. This is what AGPL is for:
  it closes the SaaS loophole that plain GPL leaves open.
- **Redistributing the code** (forking, mirroring, packaging) — must
  carry the LICENSE and offer source.
- **No warranty.** See LICENSE for the full disclaimer — it's the same
  "use at your own risk" idea baked into the sign-in footer.

If you're unsure whether your use case triggers the share-back
obligation, the [AGPLv3 page on gnu.org](https://www.gnu.org/licenses/agpl-3.0.html)
is the authoritative source.
