-- M2: the reminder model + supporting tables. reminder_fires/suppressions/
-- audit_log aren't used yet but land in the same migration so the M3/M5
-- code doesn't need a follow-up schema change.

CREATE TABLE reminders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  title           TEXT NOT NULL,
  body_md         TEXT NOT NULL DEFAULT '',
  rrule           TEXT NOT NULL,
  -- ISO-8601 wall-clock time (no offset), interpreted in `timezone` below.
  -- e.g. '2026-05-25T08:00:00' + 'America/Los_Angeles' = 15:00 UTC.
  dtstart         TEXT NOT NULL,
  timezone        TEXT NOT NULL,
  -- Cached UTC moment of the next firing; recomputed after each send and
  -- on each PATCH that affects scheduling. NULL = exhausted/completed.
  next_fire_at    TEXT,
  -- NULL = indefinite; positive integer = number of fires still to send.
  remaining_count INTEGER,
  status          TEXT NOT NULL DEFAULT 'active', -- active|paused|completed|suspended|deleted
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_reminders_due ON reminders(status, next_fire_at);
CREATE INDEX idx_reminders_user ON reminders(user_id);

CREATE TABLE reminder_fires (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reminder_id         INTEGER NOT NULL REFERENCES reminders(id),
  fire_at             TEXT NOT NULL,    -- ISO UTC of the scheduled firing
  sent_at             TEXT,             -- ISO UTC when the send actually completed
  mailgun_message_id  TEXT,
  status              TEXT NOT NULL,    -- queued|sent|failed|skipped
  error               TEXT,
  action_consumed_at  TEXT,             -- non-null once any action token used
  UNIQUE(reminder_id, fire_at)
);
CREATE INDEX idx_reminder_fires_reminder ON reminder_fires(reminder_id);

CREATE TABLE suppressions (
  email        TEXT PRIMARY KEY COLLATE NOCASE,
  reason       TEXT NOT NULL,           -- bounce|complaint|unsubscribe
  occurred_at  TEXT NOT NULL,
  raw          TEXT,
  cleared_at   TEXT                     -- non-null = user re-confirmed
);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  event       TEXT NOT NULL,
  meta        TEXT,                     -- JSON blob
  occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_user ON audit_log(user_id, occurred_at);
