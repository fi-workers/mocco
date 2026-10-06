// A test email sender: records every mail it is handed and answers what the test scripts
// (sent, unless `next` holds failures to give first).
import { EmailResultKinds } from '@backend/domain/notification/senders/email';

import type { EmailMessage, EmailResult, EmailSender } from '@backend/domain/notification/senders/email';

export interface RecordingEmailSender extends EmailSender {
  /** Every mail handed to the sender, in order (failed ones included). */
  readonly mails: EmailMessage[];
  /** Results to give the next sends, before falling back to `sent`. */
  readonly next: EmailResult[];
  /** The mails sent to `to`. */
  to(to: string): EmailMessage[];
}

export function createRecordingEmailSender(): RecordingEmailSender {
  const mails: EmailMessage[] = [];
  const next: EmailResult[] = [];
  return {
    mails,
    next,
    to: to => mails.filter(mail => mail.to === to),
    send: async message => {
      mails.push(message);
      return await Promise.resolve(next.shift() ?? { kind: EmailResultKinds.sent, messageId: `m${mails.length}` });
    },
  };
}
