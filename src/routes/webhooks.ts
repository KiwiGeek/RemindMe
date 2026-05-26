/**
 * Mailgun webhook receiver.
 *
 *   POST /webhooks/mailgun
 *
 * The endpoint is public (Mailgun calls it directly). Authenticity is
 * established by the HMAC signature in the payload; we verify it before
 * touching any state. Anything that fails verification gets 401 so Mailgun
 * stops retrying immediately; events we *can't* handle (unknown shape,
 * other event types) return 200 so they don't keep retrying for hours.
 *
 * Event routing:
 *
 *   failed + severity=permanent  -> suspend address as bounce
 *   complained                    -> suspend address as complaint
 *   unsubscribed                  -> suspend address as unsubscribe
 *   failed + severity=temporary   -> audit only (no suspension)
 *   anything else                  -> 200 OK no-op
 *
 * We dedupe by Mailgun's per-delivery `token` in KV. Multiple identical
 * deliveries of the same event become a no-op after the first.
 */

import { Hono } from 'hono';
import { getDb } from '~/db/client';
import { auditLog } from '~/db/schema';
import type { AppBindings } from '~/env';
import {
  type MailgunSignature,
  dedupeMailgunToken,
  verifyMailgunSignature,
} from '~/lib/mailgunWebhook';
import { suspendAddress } from '~/lib/suppression';

interface MailgunWebhookPayload {
  signature?: MailgunSignature;
  'event-data'?: {
    event?: string;
    severity?: string;
    recipient?: string;
    reason?: string;
    'delivery-status'?: { description?: string; message?: string };
    timestamp?: number;
  };
}

export const webhooks = new Hono<AppBindings>().post('/mailgun', async (c) => {
  // Read the raw body once so we can both parse it and (optionally) include
  // a slice in the audit log for diagnosis.
  let payload: MailgunWebhookPayload;
  try {
    payload = (await c.req.json()) as MailgunWebhookPayload;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const sig = payload.signature;
  if (
    !sig ||
    typeof sig.timestamp !== 'string' ||
    typeof sig.token !== 'string' ||
    typeof sig.signature !== 'string'
  ) {
    return c.json({ error: 'missing_signature' }, 401);
  }

  const verification = await verifyMailgunSignature(c.env.MAILGUN_SIGNING_KEY, sig);
  if (!verification.ok) {
    console.warn('mailgun webhook rejected', verification.reason);
    return c.json({ error: verification.reason }, 401);
  }

  const fresh = await dedupeMailgunToken(c.env, sig.token);
  if (!fresh) {
    // 200 so Mailgun considers it delivered. The audit row from the first
    // delivery is the source of truth.
    return c.json({ ok: true, deduped: true });
  }

  const data = payload['event-data'];
  if (!data || typeof data.event !== 'string') {
    return c.json({ ok: true, ignored: 'no_event_data' });
  }
  const event = data.event.toLowerCase();
  const recipient = (data.recipient ?? '').trim().toLowerCase();
  const reasonText = data.reason ?? data['delivery-status']?.description ?? null;

  if (event === 'failed' && data.severity === 'permanent') {
    if (!recipient) return c.json({ ok: true, ignored: 'no_recipient' });
    await suspendAddress(c.env, {
      email: recipient,
      reason: 'bounce',
      raw: reasonText,
    });
    return c.json({ ok: true, action: 'suspended', reason: 'bounce' });
  }

  if (event === 'complained') {
    if (!recipient) return c.json({ ok: true, ignored: 'no_recipient' });
    await suspendAddress(c.env, {
      email: recipient,
      reason: 'complaint',
      raw: reasonText,
    });
    return c.json({ ok: true, action: 'suspended', reason: 'complaint' });
  }

  if (event === 'unsubscribed') {
    if (!recipient) return c.json({ ok: true, ignored: 'no_recipient' });
    await suspendAddress(c.env, {
      email: recipient,
      reason: 'unsubscribe',
      raw: reasonText,
    });
    return c.json({ ok: true, action: 'suspended', reason: 'unsubscribe' });
  }

  if (event === 'failed' && data.severity === 'temporary') {
    // Transient failures are informational. Record so we can spot patterns
    // later but don't penalize the user — Mailgun will retry on its own.
    if (recipient) {
      const db = getDb(c.env);
      await db.insert(auditLog).values({
        userId: null,
        event: 'soft_bounce',
        meta: JSON.stringify({ email: recipient, reason: reasonText }),
      });
    }
    return c.json({ ok: true, action: 'noted_soft_bounce' });
  }

  return c.json({ ok: true, ignored: event });
});
