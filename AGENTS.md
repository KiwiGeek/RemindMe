# AGENTS.md

Persistent guidance for AI agents (and humans) working in this repository.

> If you're picking up work here, read `PLAN.md` first for the *what* and
> *why*. This file is the *how* and the *don'ts*.

## Project at a glance

**Remind Me** — passwordless recurring-email reminder service hosted on
Cloudflare Workers (free tier), delivering via Mailgun (US region), at
`https://remindme.example.com`.

Owner: `example.com`. GitHub repo: `RemindMe` (private).

## Architecture in one breath

Single Cloudflare Worker that (a) serves the SPA + JSON API, (b) runs a
`*/5 * * * *` cron with a 6-minute look-ahead to send due reminders (and
prune retention rows), (c) receives Mailgun webhooks at `/webhooks/mailgun`,
(d) handles email-action links at `/r/:token`. D1 is the source of truth;
a single `KV` binding holds OTP codes, rate-limit counters, Mailgun
webhook-dedupe tokens, and WebAuthn challenges (all prefix-namespaced);
secrets are Worker secrets. Recurrence is RFC 5545 RRULE.

See `PLAN.md` §5 for the diagram and §6 for the schema.

## Stack (canonical — do not swap without discussion)

- TypeScript (strict).
- Cloudflare Workers + Wrangler v3.
- Hono router.
- D1 + Drizzle ORM (migrations checked in under `migrations/`).
- `rrule` for recurrence; `luxon` for timezones.
- `markdown-it` + `xss` for reminder body rendering.
- `@simplewebauthn/server` + `/browser` for optional passkey sign-in.
- Preact + Vite + TailwindCSS (v4, class-based dark mode) for the SPA.
- Biome for lint + format.
- Vitest + `@cloudflare/vitest-pool-workers` for tests (Windows runs
  pinned to `singleWorker: true` to avoid workerd loopback flakes).

## Repository layout (target)

```
/                       repo root
├── PLAN.md             plan, decisions, milestones
├── AGENTS.md           this file
├── README.md           human-facing onboarding
├── wrangler.toml       Worker config
├── package.json
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── migrations/         D1 migrations
├── src/
│   ├── index.ts        Worker entry: fetch + scheduled
│   ├── routes/         Hono route handlers (auth, reminders, webhooks, r)
│   ├── lib/            shared utilities (auth, mailgun, rrule, render)
│   ├── db/             Drizzle schema + helpers
│   └── tests/          unit + integration tests
├── web/                Vite + Preact SPA
│   ├── index.html
│   ├── src/
│   └── vite.config.ts
└── .github/workflows/  CI (lint + typecheck + test + build)
```

The Worker serves `web/dist/` as static assets; the SPA calls the same origin
under `/api/*`.

## Conventions

### Code

- **TypeScript strict.** No `any` without an `// eslint-disable-next-line`-
  style justification comment. Prefer `unknown` + narrowing.
- **No default exports** in `src/` except the Worker `fetch`/`scheduled`
  export from `src/index.ts`.
- **Pure functions where possible.** Side effects (DB, fetch) live behind
  small, mockable helpers in `src/lib/`.
- **One Hono route per file** for non-trivial routes; group small ones.
- **Errors:** throw `HTTPException` from Hono; never leak stack traces or DB
  errors to clients. Log to `console.error` (captured by Workers Logs).

### Comments

- Comments explain *intent / trade-off / constraint*, never narrate code.
- Banned: "// Increment counter", "// Return result", "// Import X". Delete
  on sight.

### SQL

- All schema changes go through a new Drizzle migration. Never edit a
  shipped migration.
- Timestamps stored as ISO-8601 UTC strings (D1 has no native timestamp
  type and SQLite's `datetime('now')` returns UTC text).

### Time

- Always store UTC. Convert at the edges using `luxon` + the user's IANA TZ.
- Never use `Date.now()` for business logic that crosses the user's local
  midnight; use a TZ-aware computation.

### Money / counts

- N/A for now — no billing.

## Testing rules

- Every route handler has at least one happy-path + one auth-failure test.
- Cron handler tested with a frozen clock + seeded D1.
- Mailgun calls mocked at the `fetch` boundary.
- Don't add a test "to test the change"; tests should describe behaviour we
  intend to keep.

## Security non-negotiables

- OTPs hashed at rest (+ Worker pepper); never log raw codes or session
  tokens.
- All Markdown sanitised before email render. No `<script>`, no
  `javascript:` URLs, no inline event handlers.
- Mailgun webhook signature verified before any DB mutation.
- Action tokens (snooze/skip/done/unsubscribe) HMAC-signed and single-use.
- Rate-limit `POST /api/auth/request` and `POST /api/reminders`.

## Things NOT to do

- Don't add a backend framework heavier than Hono.
- Don't introduce Workers Paid features (Queues, Durable Objects, Workers
  for Platforms) without raising it in `PLAN.md` first — we're staying on
  free tier.
- Don't store secrets in `wrangler.toml`; use `wrangler secret put`.
- Don't roll our own crypto; use `crypto.subtle` (Web Crypto, available in
  Workers).
- Don't add a UI framework on top of Preact (no Material UI, etc.). Tailwind
  + handwritten components.
- Don't ship a generated `web/dist/` to git; build in CI.

## Common commands

```bash
# install
npm install

# dev (Worker + SPA together; auto-applies local D1 migrations)
npm run dev

# manually fire the scheduler against local dev
curl 'http://localhost:8787/__scheduled?cron=*/5+*+*+*+*'

# DB
npx wrangler d1 migrations create remindme <name>
npx wrangler d1 migrations apply remindme --local
npx wrangler d1 migrations apply remindme --remote

# secrets (5 — MAILGUN_DOMAIN, ADMIN_EMAILS, APP_NAME, SITE_ORIGIN
# live in [vars] in wrangler.toml, not as secrets)
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_SIGNING_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put OTP_PEPPER
npx wrangler secret put ACTION_TOKEN_SECRET

# checks
npm run lint        # biome check
npm run lint:fix    # biome check --write
npm run typecheck   # tsc + tsc -p web
npm test            # vitest run
npm run build       # SPA build (web/dist)

# deploy (applies remote migrations, builds, then wrangler deploy)
npm run deploy
```

## Where to put questions you can't answer yourself

Add them to `PLAN.md` §15 ("Open Questions") rather than guessing. Flag
working assumptions inline with **[ASSUMPTION]** and the rationale.
