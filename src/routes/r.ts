/**
 * Public, token-authenticated entry point for email-action links.
 *
 *   GET  /r/:token   Decode the token. For fire actions that need
 *                    confirmation (currently just `done`), render a
 *                    confirm page. For all others apply the action and
 *                    render a small status page. For magic-link tokens,
 *                    set a session cookie and 302 to `/`.
 *
 *   POST /r/:token   Same as GET but used by:
 *                      - The "Yes, mark done" form on the confirm page.
 *                      - RFC 8058 one-click List-Unsubscribe (mail clients
 *                        send POST with `List-Unsubscribe=One-Click`).
 *
 * Tokens are stateless HMAC blobs (see ~/lib/actionToken). Single-use is
 * enforced via `reminder_fires.action_consumed_at`: once any fire-action
 * URL for a given fire is exercised, all of that fire's other action URLs
 * become 410-style "already actioned" responses.
 */

import { and, eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { html, raw } from 'hono/html';
import { getDb } from '~/db/client';
import { reminderFires, reminders, users } from '~/db/schema';
import type { AppBindings } from '~/env';
import {
  type FireActionPayload,
  type SnoozeDuration,
  snoozeDurationSeconds,
  verifyFireAction,
  verifyMagicLink,
} from '~/lib/actionToken';
import { nextFires } from '~/lib/recurrence';
import { signSession, writeSessionCookie } from '~/lib/session';

type Ctx = Context<AppBindings>;

export const r = new Hono<AppBindings>()
  .get('/:token', (c) => handle(c, c.req.param('token'), 'GET'))
  .post('/:token', (c) => handle(c, c.req.param('token'), 'POST'));

async function handle(c: Ctx, token: string, method: 'GET' | 'POST') {
  // Try magic-link first; it's user-scoped and never burns a fire row.
  const magic = await verifyMagicLink(c.env.ACTION_TOKEN_SECRET, token);
  if (magic) {
    const db = getDb(c.env);
    const user = (await db.select().from(users).where(eq(users.id, magic.uid)).limit(1))[0];
    if (!user || user.status !== 'active') {
      return c.html(
        page('Link expired', 'Your magic link is no longer valid. Sign in from the home page.'),
        410,
      );
    }
    const session = await signSession(c.env.SESSION_SECRET, user.id);
    writeSessionCookie(c, session);
    return c.redirect('/', 302);
  }

  const fire = await verifyFireAction(c.env.ACTION_TOKEN_SECRET, token);
  if (!fire) {
    return c.html(page('Link invalid or expired', 'This action link is no longer valid.'), 410);
  }

  if (fire.op === 'done' && method === 'GET') {
    // Two-step confirm. Renders a form that POSTs back to the same URL.
    return c.html(confirmPage(token), 200);
  }

  return applyFireAction(c, fire);
}

async function applyFireAction(c: Ctx, payload: FireActionPayload) {
  const db = getDb(c.env);

  // Look up the fire and its parent reminder in one round trip.
  const rows = await db
    .select({ fire: reminderFires, reminder: reminders })
    .from(reminderFires)
    .innerJoin(reminders, eq(reminders.id, reminderFires.reminderId))
    .where(and(eq(reminderFires.id, payload.fid), eq(reminderFires.reminderId, payload.rid)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return c.html(page('Link invalid', "We can't find the reminder this link refers to."), 404);
  }
  const { fire, reminder } = row;

  if (fire.actionConsumedAt) {
    return c.html(
      page(
        'Already actioned',
        `You already used a link from this email (${escapeHtml(fire.actionConsumedAt)} UTC). Open the dashboard to make further changes.`,
      ),
      200,
    );
  }
  if (reminder.status === 'deleted') {
    return c.html(page('Reminder deleted', 'This reminder no longer exists.'), 410);
  }

  const nowIso = new Date().toISOString();

  const apply = async (updates: Partial<typeof reminders.$inferInsert>) => {
    await db
      .update(reminders)
      .set({ ...updates, updatedAt: nowIso })
      .where(eq(reminders.id, reminder.id));
    await db
      .update(reminderFires)
      .set({ actionConsumedAt: nowIso })
      .where(eq(reminderFires.id, fire.id));
  };

  if (payload.op.startsWith('snooze:')) {
    const duration = payload.op.split(':')[1] as SnoozeDuration;
    const newFire = new Date(Date.now() + snoozeDurationSeconds(duration) * 1000).toISOString();
    await apply({ nextFireAt: newFire, status: 'active' });
    return c.html(
      page(
        'Snoozed',
        `We'll send "${escapeHtml(reminder.title)}" again at ${escapeHtml(newFire)} UTC. The rest of the schedule is unchanged after that.`,
      ),
      200,
    );
  }

  if (payload.op === 'skip') {
    // Skip the *natural* next occurrence: compute it from the RRULE rather
    // than from "now", so a recipient who opens the email well after the
    // intended fire still skips the right one.
    const cursor = reminder.nextFireAt ?? fire.fireAt;
    const next =
      nextFires(
        { rrule: reminder.rrule, dtstart: reminder.dtstart, timezone: reminder.timezone },
        1,
        { afterUtc: cursor },
      )[0] ?? null;
    let newStatus: typeof reminder.status = reminder.status;
    let newRemaining = reminder.remainingCount;
    if (reminder.remainingCount !== null) {
      newRemaining = Math.max(0, reminder.remainingCount - 1);
      if (newRemaining === 0) {
        newStatus = 'completed';
      }
    } else if (!next) {
      newStatus = 'completed';
    }
    await apply({
      nextFireAt: newStatus === 'completed' ? null : next,
      remainingCount: newRemaining,
      status: newStatus,
    });
    return c.html(
      page(
        'Skipped',
        `Skipped the next occurrence of "${escapeHtml(reminder.title)}". The schedule continues from there.`,
      ),
      200,
    );
  }

  if (payload.op === 'done' || payload.op === 'unsub') {
    await apply({ status: 'completed', nextFireAt: null });
    return c.html(
      page(
        payload.op === 'done' ? 'Series done' : 'Unsubscribed',
        `You won't get any more emails for "${escapeHtml(reminder.title)}". You can re-enable it from the dashboard if you change your mind.`,
      ),
      200,
    );
  }

  return c.html(page('Unknown action', "We didn't recognise this action."), 400);
}

const baseStyles = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 48px 24px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { font-size: 14px; line-height: 1.5; color: #333; }
  a, button { color: #111; }
  form { margin-top: 16px; }
  button.primary { background:#111;color:#fff;border:none;padding:10px 16px;border-radius:8px;font-size:14px;cursor:pointer; }
  button.secondary { background:transparent;border:1px solid #ccc;padding:10px 16px;border-radius:8px;font-size:14px;cursor:pointer;margin-left:8px; }
`;

function page(title: string, body: string) {
  return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} · Remind Me</title><style>${raw(baseStyles)}</style></head>
<body>
  <h1>${title}</h1>
  <p>${body}</p>
  <p><a href="/">Back to Remind Me →</a></p>
</body>
</html>`;
}

function confirmPage(token: string) {
  return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mark series done · Remind Me</title><style>${raw(baseStyles)}</style></head>
<body>
  <h1>Mark this series done?</h1>
  <p>This will stop sending this reminder. You can re-enable it from the dashboard for the next 24 hours if you change your mind.</p>
  <form method="POST" action="/r/${token}">
    <button type="submit" class="primary">Yes, mark done</button>
    <a href="/" class="secondary" style="display:inline-block;text-decoration:none;line-height:20px;">Cancel</a>
  </form>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
