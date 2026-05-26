/**
 * Builds the outgoing reminder email (HTML + plain text) and the
 * List-Unsubscribe header. Layout is intentionally plain-vanilla; rich
 * styling lands in M6 polish.
 */

import type { FireAction, SnoozeDuration } from '~/lib/actionToken';
import { SNOOZE_DURATIONS } from '~/lib/actionToken';
import type { RenderedReminder } from '~/lib/render';

export interface ReminderEmailLinks {
  /** Each fire action's signed URL (`${siteOrigin}/r/${token}`). */
  fireActions: Record<FireAction, string>;
  /** Magic-link sign-in for the "Manage your reminders" footer link. */
  manageUrl: string;
  /** RFC 8058 one-click target — usually the `unsub` action URL. */
  listUnsubscribeUrl: string;
}

export interface ReminderEmailInputs {
  rendered: RenderedReminder;
  links: ReminderEmailLinks;
}

export interface ReminderEmail {
  subject: string;
  text: string;
  html: string;
  /** Value for the RFC 8058 `List-Unsubscribe` header (URL, no angle brackets). */
  listUnsubscribe: string;
}

const SNOOZE_LABELS: Record<SnoozeDuration, string> = {
  '1h': '1 hour',
  '3h': '3 hours',
  '1d': '1 day',
  '3d': '3 days',
  '1w': '1 week',
};

export function buildReminderEmail({ rendered, links }: ReminderEmailInputs): ReminderEmail {
  const snoozeButtonsHtml = SNOOZE_DURATIONS.map((d) => {
    const url = links.fireActions[`snooze:${d}`];
    return `<a href="${escapeAttr(url)}" style="display:inline-block;margin:0 6px 6px 0;padding:6px 10px;border:1px solid #ccc;border-radius:6px;color:#333;text-decoration:none;font-size:12px;">${SNOOZE_LABELS[d]}</a>`;
  }).join('');

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(rendered.subject)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111;">
  ${rendered.htmlBody}
  <hr style="border:none;border-top:1px solid #ddd;margin:32px 0 16px;">
  <p style="font-size:12px;color:#666;margin:0 0 8px;">Snooze this reminder:</p>
  <p style="margin:0 0 16px;">${snoozeButtonsHtml}</p>
  <p style="font-size:12px;color:#666;margin:0;">
    <a href="${escapeAttr(links.fireActions.skip)}" style="color:#666;">Skip the next one</a>
    &nbsp;·&nbsp;
    <a href="${escapeAttr(links.fireActions.done)}" style="color:#666;">Mark series done</a>
    &nbsp;·&nbsp;
    <a href="${escapeAttr(links.fireActions.unsub)}" style="color:#666;">Unsubscribe from this reminder</a>
  </p>
  <p style="font-size:12px;color:#999;margin:16px 0 0;">
    <a href="${escapeAttr(links.manageUrl)}" style="color:#999;">Manage all your reminders</a>
  </p>
</body>
</html>`;

  const text = [
    rendered.textBody,
    '',
    '---',
    'Snooze this reminder:',
    ...SNOOZE_DURATIONS.map((d) => `  ${SNOOZE_LABELS[d]}: ${links.fireActions[`snooze:${d}`]}`),
    '',
    `Skip the next one:        ${links.fireActions.skip}`,
    `Mark series done:         ${links.fireActions.done}`,
    `Unsubscribe (this only):  ${links.fireActions.unsub}`,
    '',
    `Manage all your reminders: ${links.manageUrl}`,
    '',
  ].join('\n');

  return {
    subject: rendered.subject,
    text,
    html,
    listUnsubscribe: links.listUnsubscribeUrl,
  };
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
