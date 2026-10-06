// The SMTP driver: what it hands nodemailer (through its JSON transport, which renders the message
// without a network), and how relay failures map to transient and permanent.
import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';

import { EmailResultKinds } from '@backend/domain/notification/senders/email';
import { SmtpEmailSender } from '@backend/domain/notification/senders/smtp';

const MAIL = {
  to: 'kim@example.test',
  subject: 'Hello',
  text: 'Plain',
  html: '<p>Rich</p>',
  headers: { 'List-Unsubscribe': '<https://mocco.test/u>' },
};

const failing = (error: unknown) =>
  new SmtpEmailSender({ sendMail: async () => await Promise.reject(error) }, 'status@acme.test');

describe('SmtpEmailSender', () => {
  it('sends the mail from the configured address with its headers', async () => {
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the JSON transport renders the mail, it sends nothing
    const transport = createTransport({ jsonTransport: true });
    const sent: unknown[] = [];
    const sender = new SmtpEmailSender(
      {
        sendMail: async mail => {
          const info = await transport.sendMail(mail);
          sent.push(JSON.parse(info.message));
          return info;
        },
      },
      'Acme Status <status@acme.test>',
    );

    expect(await sender.send(MAIL)).toMatchObject({ kind: EmailResultKinds.sent });
    expect(sent).toEqual([
      expect.objectContaining({
        from: { address: 'status@acme.test', name: 'Acme Status' },
        to: [{ address: 'kim@example.test', name: '' }],
        subject: 'Hello',
        text: 'Plain',
        html: '<p>Rich</p>',
        headers: { 'List-Unsubscribe': '<https://mocco.test/u>' },
      }),
    ]);
  });

  it('treats a 5xx reply as permanent and anything else as transient', async () => {
    expect(await failing(Object.assign(new Error('550 no such user'), { responseCode: 550 })).send(MAIL)).toEqual({
      kind: EmailResultKinds.permanent,
      reason: '550 no such user',
    });
    expect(await failing(Object.assign(new Error('421 busy'), { responseCode: 421 })).send(MAIL)).toEqual({
      kind: EmailResultKinds.transient,
      reason: '421 busy',
    });
    expect(await failing(new Error('connect ECONNREFUSED')).send(MAIL)).toEqual({
      kind: EmailResultKinds.transient,
      reason: 'connect ECONNREFUSED',
    });
  });
});
