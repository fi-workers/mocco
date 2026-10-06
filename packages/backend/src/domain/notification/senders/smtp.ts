// The SMTP driver of the email sender (`EMAIL_DRIVER=smtp`), the only nodemailer importer. Any
// SMTP relay works: a self-hosted Postfix, a provider's SMTP endpoint, or a local sink such as
// Mailpit in development.
import { createTransport } from 'nodemailer';

import { EmailResultKinds } from '@backend/domain/notification/senders/email';

import type { EmailMessage, EmailResult, EmailSender } from '@backend/domain/notification/senders/email';

/** The part of a nodemailer transport the sender uses. */
export interface SmtpTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: unknown }>;
}

/** The SMTP reply code of a nodemailer error, when it carries one. */
function responseCodeOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'responseCode' in error) {
    const code: unknown = error.responseCode;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

/** A failure as one line without the relay's credentials (nodemailer never puts them in messages). */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line sonarjs/null-dereference -- message is a string on both branches
  return message.slice(0, 500);
}

export class SmtpEmailSender implements EmailSender {
  /** A sender over an `smtp://` (STARTTLS when the relay offers it) or `smtps://` URL, with the
   * credentials in the URL. */
  static fromUrl(url: string, from: string): SmtpEmailSender {
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the operator's URL picks TLS (smtps:// or STARTTLS)
    return new SmtpEmailSender(createTransport(url), from);
  }

  constructor(
    private readonly transport: SmtpTransport,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      const info = await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.headers !== undefined && { headers: message.headers }),
      });
      return { kind: EmailResultKinds.sent, messageId: typeof info.messageId === 'string' ? info.messageId : null };
    } catch (error) {
      const code = responseCodeOf(error);
      // 5xx is a permanent SMTP failure; 4xx, and no reply at all (a network error), may pass later.
      const kind = code !== undefined && code >= 500 ? EmailResultKinds.permanent : EmailResultKinds.transient;
      return { kind, reason: reasonOf(error) };
    }
  }
}
