/**
 * Wraps a rendered reminder body with a minimal HTML shell + footer. M3
 * keeps the footer simple — just a "manage reminders" link. M4 adds the
 * snooze/skip/done one-click action buttons and List-Unsubscribe plumbing.
 */

import type { RenderedReminder } from '~/lib/render';

export interface ReminderEmailInputs {
  rendered: RenderedReminder;
  siteOrigin: string;
}

export interface ReminderEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildReminderEmail({ rendered, siteOrigin }: ReminderEmailInputs): ReminderEmail {
  const manageUrl = `${siteOrigin}/`;
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(rendered.subject)}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
  ${rendered.htmlBody}
  <hr style="border: none; border-top: 1px solid #ddd; margin: 32px 0 16px;">
  <p style="font-size: 12px; color: #666;">
    You're receiving this as a recurring reminder from Remind Me.
    <a href="${escapeAttr(manageUrl)}" style="color: #666;">Manage your reminders</a>.
  </p>
</body>
</html>`;

  const text = `${rendered.textBody}\n\n---\nYou're receiving this as a recurring reminder from Remind Me.\nManage your reminders: ${manageUrl}\n`;

  return { subject: rendered.subject, text, html };
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
