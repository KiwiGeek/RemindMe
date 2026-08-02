/**
 * Pick Mailgun or SMTP transport from AppConfig + runtime.
 */

import type { Env } from '~/env';
import type { AppConfig } from '~/lib/config';
import { isNodeRuntime } from '~/lib/config';
import { MailgunClient } from '~/lib/mail/mailgun';
import type { MailTransport } from '~/lib/mail/transport';
import { MailTransportError } from '~/lib/mail/transport';

export async function createMailTransport(config: AppConfig, env: Env): Promise<MailTransport> {
  if (config.mailProvider === 'smtp') {
    if (!isNodeRuntime(env)) {
      throw new MailTransportError(
        'SMTP is only supported on Docker/Node deployments',
        400,
        'smtp_not_supported',
      );
    }
    const { SmtpClient } = await import('~/lib/mail/smtp');
    return new SmtpClient(config);
  }
  return new MailgunClient(config);
}
