# Remind Me — Plan

> Living planning doc. Sections marked **[ASSUMPTION]** are working guesses
> pending confirmation; sections marked **[OPEN QUESTION]** still need input.
> Once a question is answered, fold the decision in and remove the marker.

## 1. Goal

Build a passwordless, self-serve web app at `https://remindme.example.com` that
sends recurring reminder emails on flexible schedules. Users sign in with their
email + a one-time code, then create, edit, pause, and delete reminders. The
system delivers via Mailgun and automatically suspends sending to addresses
that bounce or complain.

Constraints:

- Host on **Cloudflare's free tier** wherever possible.
- Low traffic expected — optimise for cost and simplicity over scale.
- Email transport: **Mailgun (US region)**.

## 2. Naming & Branding

- **Product name:** *Remind Me*
- **Repo name:** `RemindMe` (private GitHub repo)
- **Site origin:** `https://remindme.example.com`
- **Mailgun sending domain:** `example.com` (apex). Tracking CNAME is
  `email.example.com` (already configured in Mailgun).
- **From address:** `Remind Me <reminders@example.com>`
- **Reply-to:** `no-reply@example.com` (replies discarded; we'll add an
  auto-responder if you want one later).
- **Mailgun API base:** `https://api.mailgun.net/v3/example.com`.

> Alternate name ideas if you want to bikeshed before we commit copy:
> *Nudge*, *Recur*, *Cadence*, *Loopback*, *Habituate*. Going with **Remind Me**
> unless you swap it in the next round.

## 3. Cloudflare Free-Tier Building Blocks

| Concern | Service | Free-tier notes |
| --- | --- | --- |
| HTTP API + static SPA | Workers (with Static Assets) | 100k requests/day |
| Relational data | D1 (SQLite) | 5M reads / 100k writes per day, 5 GB |
| OTP + rate-limit counters | Workers KV | 100k reads / 1k writes per day, native TTL |
| Scheduling tick | Cron Triggers | ~5-min effective granularity on free tier |
| Secrets | Worker secrets | `wrangler secret put …` |
| Observability | Workers Logs (tail) | included |

The scheduler runs `*/5 * * * *` and queries a **6-minute look-ahead
window** so reminders always fire on or before their scheduled minute,
never noticeably late, even when ticks jitter.

No Queues, no Durable Objects, no Workers Paid plan. D1 + Cron is sufficient at
expected volume; we can graduate to DO alarms later if fan-out grows.

## 4. Tech Stack (decided)

- **Language:** TypeScript (strict).
- **Runtime:** Cloudflare Workers, single Worker for API + cron + webhook +
  static assets.
- **Router:** [Hono](https://hono.dev).
- **DB:** D1 + [Drizzle ORM](https://orm.drizzle.team) (migrations + types,
  with a raw-SQL escape hatch).
- **Recurrence:** [`rrule`](https://www.npmjs.com/package/rrule) npm package.
- **Markdown rendering (for emails):** `markdown-it` (small, sanitised output).
- **HTML sanitisation:** `sanitize-html` (or a Worker-friendly equivalent —
  may swap to `dompurify` + a tiny DOM shim if size requires).
- **Email transport:** Mailgun REST API via `fetch` (no SDK).
- **Frontend:** Preact + Vite + TypeScript, TailwindCSS for styling.
- **Lint/format:** Biome.
- **Tests:** Vitest + `@cloudflare/vitest-pool-workers`.
- **Tooling:** Wrangler v3+.

## 5. High-Level Architecture

```
[ Browser SPA ] ──► [ Worker /api/* ] ──► [ D1 ]
                          │
                          └────► Mailgun REST (OTP + reminders)

[ Worker scheduled() every minute ] ──► [ D1 ] ──► Mailgun REST

[ Mailgun webhook → Worker /api/webhooks/mailgun ] ──► [ D1 ]
```

One Worker, four entry points: `fetch` (API + static), `scheduled` (cron),
plus internal routes for the webhook and email-action callbacks.

### 5.1 Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/request` | Email + send OTP |
| `POST` | `/api/auth/verify` | Verify OTP → session cookie |
| `POST` | `/api/auth/logout` | Clear session |
| `GET`  | `/api/me` | Current user profile |
| `PATCH`| `/api/me` | Update timezone, etc. |
| `GET`  | `/api/reminders` | List |
| `POST` | `/api/reminders` | Create |
| `GET`  | `/api/reminders/:id` | Read |
| `PATCH`| `/api/reminders/:id` | Update / pause / resume |
| `DELETE`| `/api/reminders/:id` | Soft delete |
| `POST` | `/api/reminders/preview` | Preview next N fire times + sample rendered email |
| `GET`  | `/api/reminders/template-variables` | Reference list for the form |
| `GET`  | `/r/:token` | Email-action landing (snooze/skip/done/unsubscribe) |
| `POST` | `/api/webhooks/mailgun` | Bounce / complaint / unsubscribe events |
| `GET`  | `/*` | SPA shell + static assets |

### 5.2 Recurrence

Stored as **RFC 5545 RRULE** strings. The UI exposes:

- **Common patterns dropdown:**
  - Every day
  - Every weekday (Mon–Fri)
  - Every week on selected days
  - Every N weeks on selected days
  - Every month on day N
  - Every month on the Nth weekday (e.g. "first Monday")
  - Every year on a date
- **Custom (advanced)**: free-text RRULE field with live "next 5 fires"
  preview (powered by `/api/reminders/:id/preview`).

Each reminder stores `rrule`, `dtstart`, `timezone`, cached `next_fire_at`,
optional `remaining_count`.

### 5.3 Email Actions (one-click links)

Every outgoing reminder includes a footer with single-use action links:

- **Snooze** — preset durations: `1h`, `3h`, `1d`, `3d`, `1w`. Pushes
  `next_fire_at` to `now + Δ`; future schedule resumes from original RRULE.
- **Skip next** — advances past the next natural occurrence.
- **Mark series done** — sets `status='completed'`. Goes via a confirmation
  page (`/r/:token` shows "Are you sure? Undo within 24h").
- **Manage all reminders** — deep link to the dashboard with the address pre-
  filled, where the user can multi-select reminders to pause/delete/unsub.

Action tokens: HMAC-signed `{ reminder_id, fire_id, op, exp }` blob in the
URL. Each fire gets its own tokens (single-use enforced via the `fire_id` and
a `reminder_fires.action_consumed_at` column).

For one-click List-Unsubscribe header compliance (RFC 8058), `Mark series
done` doubles as the unsubscribe target for that specific reminder, *not* a
global suppression — global unsubscribe is the "Manage all" page where the
user can select which to disable.

### 5.4 Markdown + Template Variables

Reminder body is **Markdown** (rendered to safe HTML for the email + plain
text for the multipart fallback). Supported template variables:

| Variable | Example |
| --- | --- |
| `{{title}}` | "Take vitamins" |
| `{{date}}` | "Mon, 25 May 2026" |
| `{{time}}` | "8:00 AM" |
| `{{datetime}}` | "Mon, 25 May 2026 at 8:00 AM PDT" |
| `{{day_of_week}}` | "Monday" |
| `{{year}}` / `{{month}}` / `{{day}}` | "2026" / "May" / "25" |
| `{{occurrence_number}}` | "14" (1-based count of this firing) |
| `{{remaining_count}}` | "3 more after this" / "Indefinite" |
| `{{next_date}}` | "Tue, 26 May 2026" / "This is the last one" |
| `{{since_start}}` | "Day 14" |
| `{{user_email}}` | "alex@example.com" |

All variables rendered in the user's configured timezone. Unknown `{{vars}}`
left intact (so users can include literal braces if they really want).

### 5.5 Timezone Handling

- One timezone per user, stored on `users.timezone` (IANA, e.g.
  `America/Los_Angeles`).
- On first sign-in we **auto-detect** via
  `Intl.DateTimeFormat().resolvedOptions().timeZone` in the browser and
  pre-fill, then ask the user to confirm in a small "Hi, you're in
  *Los Angeles*?" banner. They can change it anytime in profile.
- All UI shows times in the user's TZ; D1 stores UTC. RRULE evaluation
  performed in the user's TZ via `rrule` + `luxon`.

## 6. Data Model (D1, via Drizzle)

```sql
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  tz_confirmed  INTEGER NOT NULL DEFAULT 0,   -- 0/1 boolean
  status        TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reminders (
  id              INTEGER PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  body_md         TEXT NOT NULL DEFAULT '',
  rrule           TEXT NOT NULL,            -- no DTSTART/TZID embedded
  dtstart         TEXT NOT NULL,            -- ISO 8601 wall-clock, no offset
  timezone        TEXT NOT NULL,            -- IANA tz, snapshot at create
  next_fire_at    TEXT,                     -- ISO UTC, NULL when exhausted
  remaining_count INTEGER,                  -- NULL = indefinite
  status          TEXT NOT NULL DEFAULT 'active', -- active|paused|completed|suspended|deleted
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reminders_due ON reminders(status, next_fire_at);
CREATE INDEX idx_reminders_user ON reminders(user_id);

CREATE TABLE reminder_fires (
  id                  INTEGER PRIMARY KEY,
  reminder_id         INTEGER NOT NULL REFERENCES reminders(id),
  fire_at             TEXT NOT NULL,
  sent_at             TEXT,
  mailgun_message_id  TEXT,
  status              TEXT NOT NULL,  -- queued|sent|failed|skipped
  error               TEXT,
  action_consumed_at  TEXT,           -- non-null once any action token used
  UNIQUE(reminder_id, fire_at)
);

CREATE TABLE suppressions (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  reason       TEXT NOT NULL,           -- bounce|complaint|unsubscribe
  occurred_at  TEXT NOT NULL,
  raw          TEXT,
  cleared_at   TEXT                     -- non-null = user re-confirmed
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER,
  event       TEXT NOT NULL,            -- login|reminder_created|suspended|...
  meta        TEXT,                     -- JSON
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

KV namespaces:

- `OTP` — keys `otp:<email_lower>` → JSON `{ code_hash, attempts }`, TTL 600s.
- `RATELIMIT` — sliding-window counters per email + per IP.

## 7. Auth Flow

1. **Request code.** `POST /api/auth/request { email }`. Always responds
   `204`. Rate-limit: max 5 codes / email / hour, 20 / IP / hour. Code is
   6-digit numeric, hashed (SHA-256 + per-Worker pepper) into KV, 10-min TTL.
2. **Verify code.** `POST /api/auth/verify { email, code }`. Up to 5 attempts
   per code. On success: upsert `users`, issue signed session cookie:
   - `sid` cookie, HttpOnly, Secure, SameSite=Lax, Max-Age = **30 days
     rolling**.
   - Value = HMAC-signed `{ user_id, iat, exp }`.
3. **First-sign-in onboarding.** If `tz_confirmed = 0`, the dashboard pops a
   one-line modal: "We think you're in *America/Los_Angeles* — keep it?"
   with a timezone picker. Confirm → set `tz_confirmed = 1`.

## 8. Bounce / Complaint Handling

- Mailgun webhooks subscribed: `permanent_fail`, `temporary_fail`,
  `complained`, `unsubscribed`.
- Worker verifies HMAC of `timestamp + token` against the webhook signing key.
- On **terminal** events (`permanent_fail`, `complained`, `unsubscribed`):
  - Insert/update `suppressions`.
  - `UPDATE reminders SET status='suspended' WHERE user_id IN (SELECT id FROM
    users WHERE email = ?) AND status='active'`.
  - `UPDATE users SET status='suspended' WHERE email = ?`.
- On **temporary** events: log only; cron retries naturally.
- Cron LEFT JOINs `suppressions` and skips matches before sending (defence in
  depth against races).
- **Self-recovery:** suspended user can still log in (OTP still sends if the
  *current* address isn't in Mailgun's own suppression list — sending OTPs
  through a separate, transactional Mailgun route may be wise, or we use a
  short manual recovery flow). On successful login, show a banner: "We
  stopped sending because emails bounced. Reactivate?" Clicking reactivate:
  - Sets `suppressions.cleared_at = now()`.
  - Removes the address from Mailgun's suppression list via Mailgun API.
  - Flips `users.status` back to `active`. User must then individually
    re-enable each suspended reminder (safer than mass-reactivating).

## 9. Frontend UX (sketch)

- `/` — logged-out: "Enter your email" → OTP input.
- `/` — logged-in dashboard:
  - Table of reminders: title, schedule summary, next fire, status pill.
  - Actions per row: edit, pause/resume, delete.
  - "New reminder" button → form (title, Markdown body, start datetime,
    timezone (inherits user default), repeat pattern, ends).
  - Preview pane shows next 5 fire times + a rendered sample email.
- `/manage?token=…` — public page reachable from email footer; lists that
  email's reminders with checkboxes to bulk pause/disable/unsubscribe without
  full sign-in (token is short-lived).
- `/r/:token` — action landing (snooze applied / confirmation for "done" /
  unsubscribe confirmation).

Accessibility: keyboard-first, semantic HTML, prefers-reduced-motion respected,
WCAG AA contrast.

## 10. Security Notes

- OTP codes hashed at rest, attempt-limited, single-use, time-bounded.
- Session cookie HMAC'd, HttpOnly, Secure, SameSite=Lax.
- CSRF: state-changing routes require `Origin` header matching the site
  origin, plus the SameSite cookie.
- Mailgun webhook signature verified before any DB write.
- Action tokens are HMAC-signed, single-use, expire after 30 days.
- All user-supplied Markdown sanitised before email render (no `<script>`,
  no `javascript:` URLs).
- Rate limits on auth + create-reminder endpoints.

## 11. Local & Deploy Workflow

- `wrangler dev` for local API + `wrangler dev --test-scheduled` for cron.
- D1 migrations in `migrations/` applied with `wrangler d1 migrations apply`.
- Secrets via `wrangler secret put`:
  `MAILGUN_API_KEY`, `MAILGUN_SIGNING_KEY`, `MAILGUN_DOMAIN`,
  `SESSION_SECRET`, `OTP_PEPPER`, `ACTION_TOKEN_SECRET`.
- One `wrangler.toml`; environments `dev` (local), `staging` (later),
  `production` (`remindme.example.com`).
- GitHub Actions CI on push: `biome check`, `vitest run`, then
  `wrangler deploy` on `main`. **[ASSUMPTION]** Add CI after M2 once there's
  enough code to be worth gating.

## 12. Out of Scope (v1)

- SMS / Slack / push channels.
- Team / shared reminders.
- ICS export / calendar sync.
- OAuth login.
- Per-reminder attachments.
- Internationalisation of UI copy (English only at launch).

## 13. Milestones

1. ~~**M0 — Scaffold.**~~ ✅ Wrangler project, Hono router, D1 binding,
   Drizzle migrations, `wrangler.toml`, Vite + Preact frontend skeleton,
   Biome, Vitest, `/api/healthz` route. Smoke-deployed to
   `remindme.workers.dev`.
2. ~~**M1 — Auth.**~~ ✅ Email + OTP via Mailgun, KV-stored hashed codes
   with attempt + per-email/IP rate limits, HMAC-signed rolling session
   cookie, `/api/me` GET+PATCH, first-sign-in timezone confirmation banner,
   bounce-recovery preflight (clears Mailgun suppressions before user-
   initiated sends), 35 tests.
3. ~~**M2 — Reminders CRUD.**~~ ✅ D1 schema for `reminders`,
   `reminder_fires`, `suppressions`, `audit_log`; recurrence engine
   (`rrule` + `luxon` wrapper, wall-clock DST-safe storage); Markdown +
   template-variable renderer (sanitised with `xss`); `/api/reminders`
   CRUD with ownership scoping + `/preview` returning fires and a sample
   rendered email; SPA dashboard with list, create/edit form, recurrence
   picker (common patterns + custom RRULE), debounced live preview,
   pause/resume/delete actions; 67 tests passing. No sending yet.
4. ~~**M3 — Scheduler.**~~ ✅ `*/5 * * * *` cron with 6-minute look-ahead
   so emails arrive on time or slightly early, never late. Per-fire
   idempotency via `reminder_fires(reminder_id, fire_at)` unique lock
   (raw `INSERT … ON CONFLICT DO UPDATE … WHERE status IN
   ('queued','failed')`) plus a deterministic `Message-Id`
   (`<reminder-{id}-{fire_at}@example.com>`) for receiver-side dedup.
   `runScheduledTick()` joins users, skips suspended owners,
   defensively skips entries already in `suppressions`, decrements
   `remaining_count`, marks completed when exhausted, and retries
   failed sends on the next tick. 50-reminder per-tick cap so a backlog
   can't blow CPU budget. 9 scheduler tests; 76 total passing.
5. **M4 — Email actions.** Snooze / skip / mark done / manage page; action
   token plumbing; List-Unsubscribe header.
6. **M5 — Bounce handling.** Mailgun webhook receiver, suspension logic,
   self-recovery flow.
7. **M6 — Polish & launch.** Custom domain DNS, production secrets,
   accessibility pass, README, deploy.

## 14. Resolved Decisions Log

- Mailgun sending domain = `example.com` (apex). Tracking CNAME
  `email.example.com` already in place.
- OTP-vs-suppression: when a user-initiated action requires sending to a
  currently-suppressed address (recovery OTP, login retry post-bounce),
  pre-call Mailgun `DELETE /v3/<domain>/bounces/<address>` (and the
  unsubscribes/complaints endpoints as needed) immediately before the send,
  and audit-log the removal. Never silently bypass for *non*-user-initiated
  sends.
- Retention: trim `reminder_fires` and `audit_log` rows older than 30 days
  via the cron handler.
- Sender display name: always `Remind Me`.
- GitHub repo: `KiwiGeek/RemindMe`, private.

## 15. Open Questions

None currently blocking. Add new ones here as they arise.
