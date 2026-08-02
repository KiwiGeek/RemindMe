/**
 * Mailgun REST transport (Workers + Node).
 */

import type { AppConfig } from '~/lib/config';
import type { MailTransport, SendMessageInput, SendMessageResult } from '~/lib/mail/transport';
import { MailTransportError } from '~/lib/mail/transport';

const BASE: Record<'us' | 'eu', string> = {
  us: 'https://api.mailgun.net/v3',
  eu: 'https://api.eu.mailgun.net/v3',
};

export class MailgunClient implements MailTransport {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly from: string;
  private readonly replyTo: string;

  constructor(config: AppConfig) {
    this.base = `${BASE[config.mailgunRegion]}/${encodeURIComponent(config.mailgunDomain)}`;
    this.authHeader = `Basic ${btoa(`api:${config.mailgunApiKey}`)}`;
    this.from = config.mailgunFrom;
    this.replyTo = config.mailgunReplyTo;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const form = new FormData();
    form.set('from', this.from);
    form.set('h:Reply-To', this.replyTo);
    form.set('to', input.to);
    form.set('subject', input.subject);
    form.set('text', input.text);
    if (input.html) form.set('html', input.html);
    if (input.tags) for (const tag of input.tags) form.append('o:tag', tag);
    if (input.listUnsubscribe) {
      form.set('h:List-Unsubscribe', `<${input.listUnsubscribe}>`);
      form.set('h:List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
    }
    if (input.messageId) {
      form.set('h:Message-Id', `<${input.messageId}>`);
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

export class MailgunError extends MailTransportError {
  constructor(message: string, status: number, body: string) {
    super(message, status, body);
    this.name = 'MailgunError';
  }
}
