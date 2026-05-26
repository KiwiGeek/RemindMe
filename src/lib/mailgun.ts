/**
 * Thin Mailgun REST client. We only need a handful of endpoints:
 *
 *   - POST   /v3/<domain>/messages          send an email
 *   - DELETE /v3/<domain>/bounces/<addr>    clear a hard-bounce suppression
 *   - DELETE /v3/<domain>/unsubscribes/<addr>
 *   - DELETE /v3/<domain>/complaints/<addr>
 *
 * Authentication is HTTP Basic with username `api` and the private API key
 * as the password.
 */

import type { Env } from '~/env';

const BASE: Record<'us' | 'eu', string> = {
  us: 'https://api.mailgun.net/v3',
  eu: 'https://api.eu.mailgun.net/v3',
};

export interface SendMessageInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Comma-separated message tags for analytics. */
  tags?: string[];
  /** RFC 8058 one-click unsubscribe target. */
  listUnsubscribe?: string;
}

export interface SendMessageResult {
  id: string;
  message: string;
}

export class MailgunError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'MailgunError';
  }
}

export class MailgunClient {
  private readonly base: string;
  private readonly authHeader: string;

  constructor(private readonly env: Env) {
    this.base = `${BASE[env.MAILGUN_REGION]}/${encodeURIComponent(env.MAILGUN_DOMAIN)}`;
    this.authHeader = `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}`;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const form = new FormData();
    form.set('from', this.env.MAILGUN_FROM);
    form.set('h:Reply-To', this.env.MAILGUN_REPLY_TO);
    form.set('to', input.to);
    form.set('subject', input.subject);
    form.set('text', input.text);
    if (input.html) form.set('html', input.html);
    if (input.tags) for (const tag of input.tags) form.append('o:tag', tag);
    if (input.listUnsubscribe) {
      form.set('h:List-Unsubscribe', `<${input.listUnsubscribe}>`);
      form.set('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
    }

    const res = await fetch(`${this.base}/messages`, {
      method: 'POST',
      headers: { authorization: this.authHeader },
      body: form,
    });

    const body = await res.text();
    if (!res.ok) {
      throw new MailgunError(`Mailgun send failed (${res.status})`, res.status, body);
    }
    try {
      return JSON.parse(body) as SendMessageResult;
    } catch {
      throw new MailgunError('Mailgun send returned non-JSON', res.status, body);
    }
  }

  /**
   * Best-effort: remove `email` from Mailgun's bounces, unsubscribes, and
   * complaints lists. Used right before sending a *user-initiated* recovery
   * OTP so a previously-suspended address can sign back in.
   *
   * Each endpoint is called independently and 404s are tolerated (means the
   * address wasn't on that list).
   */
  async clearSuppressions(email: string): Promise<void> {
    const encoded = encodeURIComponent(email);
    await Promise.all(
      ['bounces', 'unsubscribes', 'complaints'].map(async (kind) => {
        const res = await fetch(`${this.base}/${kind}/${encoded}`, {
          method: 'DELETE',
          headers: { authorization: this.authHeader },
        });
        if (!res.ok && res.status !== 404) {
          const body = await res.text();
          throw new MailgunError(`Mailgun ${kind} delete failed (${res.status})`, res.status, body);
        }
      }),
    );
  }
}
