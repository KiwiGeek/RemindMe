/**
 * OTP sign-in email. Plain-text first; the HTML version is a near-identical
 * structure for clients that prefer rich rendering. Subject line keeps the
 * code out so it doesn't leak to lockscreens or notifications.
 */

export interface OtpEmailInput {
  appName: string;
  code: string;
  expiresInMinutes: number;
  signInUrl: string;
}

export function renderOtpEmail({ appName, code, expiresInMinutes, signInUrl }: OtpEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `Your ${appName} sign-in code`;
  const text = `Your ${appName} sign-in code is:

    ${code}

It expires in ${expiresInMinutes} minutes and can only be used once.

Or sign in directly (same expiry, one use):
${signInUrl}

If you didn't request this, you can safely ignore the email — no account
was created or accessed.

— ${appName}
`;

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;">
    <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;">${escapeHtml(appName)} sign-in code</h1>
    <p style="margin:0 0 24px;color:#52525b;">Enter this code to finish signing in, or use the button below. It expires in ${expiresInMinutes} minutes and each option works once.</p>
    <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;letter-spacing:0.25em;font-weight:600;background:#f4f4f5;border-radius:8px;padding:16px;text-align:center;">${escapeHtml(code)}</div>
    <p style="margin:24px 0 16px;text-align:center;">
      <a href="${escapeHtml(signInUrl)}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:8px;">Sign in directly</a>
    </p>
    <p style="margin:0 0 8px;color:#71717a;font-size:13px;text-align:center;">Or copy this link:</p>
    <p style="margin:0 0 24px;color:#52525b;font-size:12px;word-break:break-all;text-align:center;"><a href="${escapeHtml(signInUrl)}" style="color:#52525b;">${escapeHtml(signInUrl)}</a></p>
    <p style="margin:0;color:#71717a;font-size:13px;">If you didn't request this, you can ignore the email — no account was created or accessed.</p>
  </div>
</body>
</html>`;

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
