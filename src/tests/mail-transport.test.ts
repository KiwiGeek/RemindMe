import { describe, expect, it } from 'vitest';
import type { Env } from '~/env';
import type { AppConfig } from '~/lib/config';
import { mailMessageDomain, smtpAllowed } from '~/lib/config';
import { createMailTransport } from '~/lib/mail/createTransport';
import { MailTransportError } from '~/lib/mail/transport';
import { validateMailSettings } from '~/lib/mail/validate';

function baseMailgunInput() {
  return {
    mailProvider: 'mailgun' as const,
    mailgunRegion: 'us' as const,
    mailgunDomain: 'example.com',
    mailgunFrom: 'Remind Me <noreply@example.com>',
    mailgunReplyTo: 'support@example.com',
    mailgunApiKey: 'key',
    mailgunSigningKey: 'sig',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    smtpPass: '',
  };
}

describe('mail validate + domain', () => {
  it('accepts complete mailgun settings on Workers', () => {
    const env = {} as Env;
    expect(validateMailSettings(env, baseMailgunInput())).toBeNull();
  });

  it('rejects smtp on Workers', () => {
    const env = {} as Env;
    expect(smtpAllowed(env)).toBe(false);
    expect(
      validateMailSettings(env, {
        ...baseMailgunInput(),
        mailProvider: 'smtp',
        smtpHost: 'smtp.example.com',
      }),
    ).toBe('smtp_not_supported');
  });

  it('accepts smtp when Node runtime is detected', () => {
    const env = { __db: {} } as unknown as Env;
    expect(smtpAllowed(env)).toBe(true);
    expect(
      validateMailSettings(env, {
        ...baseMailgunInput(),
        mailProvider: 'smtp',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
      }),
    ).toBeNull();
  });

  it('requires smtp host', () => {
    const env = { __db: {} } as unknown as Env;
    expect(
      validateMailSettings(env, {
        ...baseMailgunInput(),
        mailProvider: 'smtp',
        smtpHost: '',
      }),
    ).toBe('smtp_incomplete');
  });

  it('derives message domain from from-address for smtp', () => {
    const config = {
      mailProvider: 'smtp',
      mailgunDomain: '',
      mailgunFrom: 'Remind Me <ops@mail.example.org>',
    } as AppConfig;
    expect(mailMessageDomain(config)).toBe('mail.example.org');
  });

  it('createMailTransport rejects smtp on Workers', async () => {
    const env = {} as Env;
    const config = {
      ...baseMailgunInput(),
      mailProvider: 'smtp',
      smtpHost: 'smtp.example.com',
    } as AppConfig;
    await expect(createMailTransport(config, env)).rejects.toBeInstanceOf(MailTransportError);
  });
});
