/**
 * Raw SMTP transport via nodemailer — Node/Docker only.
 * Do not import this module from Workers entry paths that get bundled.
 */

import type { AppConfig } from '~/lib/config';
import type { MailTransport, SendMessageInput, SendMessageResult } from '~/lib/mail/transport';
import { MailTransportError } from '~/lib/mail/transport';

type NodemailerModule = typeof import('nodemailer');

export class SmtpClient implements MailTransport {
  private readonly config: AppConfig;
  private transporterPromise: Promise<ReturnType<NodemailerModule['createTransport']>> | null =
    null;

  constructor(config: AppConfig) {
    this.config = config;
  }

  private async transporter() {
    if (!this.transporterPromise) {
      this.transporterPromise = (async () => {
        const nodemailer = await import('nodemailer');
        return nodemailer.createTransport({
          host: this.config.smtpHost,
          port: this.config.smtpPort,
          secure: this.config.smtpSecure,
          auth:
            this.config.smtpUser || this.config.smtpPass
              ? { user: this.config.smtpUser, pass: this.config.smtpPass }
              : undefined,
        });
      })();
    }
    return this.transporterPromise;
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    try {
      const transport = await this.transporter();
      const headers: Record<string, string> = {};
      if (input.listUnsubscribe) {
        headers['List-Unsubscribe'] = `<${input.listUnsubscribe}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      if (input.messageId) {
        headers['Message-ID'] = `<${input.messageId}>`;
      }

      const info = await transport.sendMail({
        from: this.config.mailgunFrom,
        replyTo: this.config.mailgunReplyTo,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers,
      });

      const id = typeof info.messageId === 'string' ? info.messageId : String(info.messageId ?? '');
      return { id, message: 'smtp queued' };
    } catch (err) {
      const body = err instanceof Error ? err.message : String(err);
      throw new MailTransportError(`SMTP send failed: ${body}`, 502, body);
    }
  }

  async clearSuppressions(_email: string): Promise<void> {
    // No provider suppression list for generic SMTP.
  }
}
