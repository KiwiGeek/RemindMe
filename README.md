# Remind Me

Passwordless recurring reminder email service. Runs on Cloudflare Workers (free
tier) and delivers via Mailgun. Lives at <https://remindme.example.com>.

See [`PLAN.md`](./PLAN.md) for the design and [`AGENTS.md`](./AGENTS.md) for
contributor conventions.

## Status

**M4 — Email actions shipped.** Outgoing reminders carry signed one-click
links for snooze (5 durations), skip-next, mark-done (with confirm step),
per-series unsubscribe, and a magic-link "Manage all your reminders"
footer link. RFC 8058 `List-Unsubscribe` headers wire Gmail/Apple Mail's
native Unsubscribe button to the same per-fire action. Tokens are
HMAC-signed, kind-tagged (`fa.` / `ml.`), single-use via
`reminder_fires.action_consumed_at`, 30-day TTL.

## Stack

TypeScript · Hono · Cloudflare D1 + Drizzle · Workers KV · Workers Cron · Vite +
Preact + Tailwind v4 · Biome · Vitest (Workers pool) · Mailgun.

## Prerequisites

- Node 20+
- A Cloudflare account (free tier is fine)
- A Mailgun account with `example.com` (or your sending domain) verified
- `wrangler` and `gh` available on PATH (installed as project devDependency for
  Wrangler; `gh` for repo admin)

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

## Layout

See [`AGENTS.md`](./AGENTS.md#repository-layout-target).

## License

Private — no license granted.
