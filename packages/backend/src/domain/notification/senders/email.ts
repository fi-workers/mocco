// The notifications foundation's email sender (platform foundations §12): a neutral port
// with one leaf per driver. `smtp.ts` is the only nodemailer importer; `LogEmailSender` is the
// development sink, which prints each mail instead of sending it.

/** One mail, already rendered. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, such as `List-Unsubscribe`. */
  headers?: Record<string, string>;
}

export const EmailResultKinds = {
  sent: 'sent',
  /** Worth trying again later: a timeout, a refused connection, a 4xx SMTP reply. */
  transient: 'transient',
  /** Trying again won't help: a 5xx SMTP reply such as an unknown mailbox. */
  permanent: 'permanent',
} as const;

export type EmailResult =
  | { kind: typeof EmailResultKinds.sent; messageId: string | null }
  | { kind: typeof EmailResultKinds.transient | typeof EmailResultKinds.permanent; reason: string };

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailResult>;
}

/** The development sink (`EMAIL_DRIVER=log`): writes each mail to the server log, sends nothing. */
export class LogEmailSender implements EmailSender {
  constructor(private readonly write: (line: string) => void = line => console.warn(line)) {}

  async send(message: EmailMessage): Promise<EmailResult> {
    const headers = Object.entries(message.headers ?? {}).map(([name, value]) => `${name}: ${value}`);
    this.write(
      [
        '[email:log] not sent (EMAIL_DRIVER=log)',
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        ...headers,
        '',
        message.text,
      ].join('\n'),
    );
    return await Promise.resolve({ kind: EmailResultKinds.sent, messageId: null });
  }
}
