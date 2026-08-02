/**
 * Shared mail transport surface used by auth, scheduler, and admin test-email.
 */

export interface SendMessageInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tags?: string[];
  listUnsubscribe?: string;
  messageId?: string;
}

export interface SendMessageResult {
  id: string;
  message: string;
}

export interface MailTransport {
  send(input: SendMessageInput): Promise<SendMessageResult>;
  clearSuppressions(email: string): Promise<void>;
}

export class MailTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'MailTransportError';
  }
}
