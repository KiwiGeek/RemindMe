/**
 * Validate mail settings for setup / admin PATCH.
 */

import type { MailProvider } from '~/db/schema';
import type { Env } from '~/env';
import { smtpAllowed } from '~/lib/config';

export interface MailSettingsInput {
  mailProvider: MailProvider;
  mailgunRegion: 'us' | 'eu';
  mailgunDomain: string;
  mailgunFrom: string;
  mailgunReplyTo: string;
  mailgunApiKey: string;
  mailgunSigningKey: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
}

export type MailValidationError =
  | 'smtp_not_supported'
  | 'mailgun_incomplete'
  | 'smtp_incomplete'
  | 'invalid_smtp_port';

export function validateMailSettings(
  env: Env,
  input: MailSettingsInput,
): MailValidationError | null {
  if (input.mailProvider === 'smtp' && !smtpAllowed(env)) {
    return 'smtp_not_supported';
  }
  if (!input.mailgunFrom.trim() || !input.mailgunReplyTo.trim()) {
    return input.mailProvider === 'smtp' ? 'smtp_incomplete' : 'mailgun_incomplete';
  }
  if (input.mailProvider === 'mailgun') {
    if (
      !input.mailgunDomain.trim() ||
      !input.mailgunApiKey.trim() ||
      !input.mailgunSigningKey.trim()
    ) {
      return 'mailgun_incomplete';
    }
    return null;
  }
  if (!input.smtpHost.trim()) return 'smtp_incomplete';
  if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65535) {
    return 'invalid_smtp_port';
  }
  return null;
}
