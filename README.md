# Remind Me

Passwordless recurring reminder email service. Runs on Cloudflare Workers (free
tier) and delivers via Mailgun. Lives at <https://remindme.example.com>.

See [`PLAN.md`](./PLAN.md) for the design and [`AGENTS.md`](./AGENTS.md) for
contributor conventions.

## Status

**M5 — Bounce handling shipped.** `POST /webhooks/mailgun` accepts
Mailgun's webhook events (signed HMAC-SHA256 over `timestamp + token`,
±30-min replay window, per-delivery `token` deduped in KV for 24h).
Hard bounces, complaints, and Mailgun-level unsubscribes suspend the
address: the local `suppressions` row is upserted, the matching user is
flipped to `suspended`, and their active/paused reminders go to
`suspended` too — all idempotent. Soft bounces are audit-only; Mailgun
retries on its own. Recovery is automatic on the next OTP sign-in: the
user proving they own the inbox flips `users.status` back to `active`
and clears the suppression row. Per-reminder reactivation stays opt-in
— the dashboard renders a green "Reactivate" button on each suspended
reminder, and the server recomputes `next_fire_at` so neither
reactivation nor "resume after a long pause" floods the inbox with
backlog emails.

**M4.6 — Optional passkey sign-in shipped.** Users can opt in to passkey
auth from the dashboard's Passkeys section (Touch ID, Windows Hello,
1Password, etc.). The sign-in screen offers a "Sign in with a passkey"
button next to the email form. Passkeys are layered on top of email OTP
— OTP still works for every account, so deleting your last passkey is
never a lockout. Authentication uses discoverable credentials (no email
entered; the browser picks the passkey). RP ID and expected origin are
derived per-request from the `Origin` header, so `localhost` and
`remindme.example.com` both work without env churn.

**M4.5 — Admin console shipped.** Operators listed in `ADMIN_EMAILS` get
an `Admin` button in the header that opens a separate console for
managing other users' reminders. Admins can search users, create users
who have never signed in (the standard OTP flow later claims the row),
change a target's timezone, and full-CRUD any reminder. Every admin
mutation lands in `audit_log`. The target user_id always comes from the
URL, never the session — admins do not impersonate.

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

The admin allow-list is the `ADMIN_EMAILS` var in `wrangler.toml` — a
comma-separated, case-insensitive list of email addresses. There is no
DB-stored admin flag on purpose: escalating to admin requires shipping a
new Worker version, which in turn requires already controlling the
deploy pipeline.

To add or remove an admin:

```toml
[vars]
ADMIN_EMAILS = "admin@example.com,ops@example.com"
```

Then `npm run deploy`. Affected accounts pick up the new role on their
next `GET /api/me`.

### Mailgun webhook setup (M5)

Bounce/complaint handling requires Mailgun to POST events to the Worker.
Once deployed:

1. Mailgun dashboard → **Sending → Webhooks** → pick the sending domain
   (`example.com`).
2. For each of these events, set the URL to
   `https://remindme.example.com/webhooks/mailgun`:
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

## Layout

See [`AGENTS.md`](./AGENTS.md#repository-layout-target).

## License

Private — no license granted.
