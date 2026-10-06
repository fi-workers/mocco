// Subscriber mail templates: every customer string escaped in HTML, the confirmation without an
// unsubscribe header and the others with one, and both languages.
import { IncidentStatuses, MaintenanceStatuses, SubscriberLocales, SubscriberMailKinds } from '@mocco/common/status';
import { describe, expect, it } from 'vitest';

import {
  renderSubscriberMail,
  renderSubscriberPage,
  SubscriberPageKinds,
} from '@backend/domain/status/subscriber-mail';

const LINKS = { confirmUrl: 'https://mocco.test/c?token=a', unsubscribeUrl: 'https://mocco.test/u?token=b' };

describe('renderSubscriberMail', () => {
  it('escapes what the customer wrote', () => {
    const mail = renderSubscriberMail(
      {
        kind: SubscriberMailKinds.incidentUpdate,
        incidentTitle: '<script>alert(1)</script>',
        status: IncidentStatuses.identified,
        body: 'Line one\nline <b>two</b>\n\nNext paragraph',
        components: ['API & Web'],
        postedAt: '2026-10-06T09:00:00.000Z',
      },
      { locale: SubscriberLocales.en, pageTitle: 'Acme "status"', ...LINKS },
    );

    expect(mail.subject).toBe('[Acme "status"] Identified: <script>alert(1)</script>');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;: Identified');
    expect(mail.html).toContain('<p>Line one<br>line &lt;b&gt;two&lt;/b&gt;</p><p>Next paragraph</p>');
    expect(mail.html).toContain('Affects: API &amp; Web');
    expect(mail.text).toContain('Unsubscribe: https://mocco.test/u?token=b');
    expect(mail.headers).toEqual({
      'List-Unsubscribe': '<https://mocco.test/u?token=b>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('writes the confirmation with its link only, in Korean too', () => {
    const en = renderSubscriberMail(
      { kind: SubscriberMailKinds.confirmation },
      { locale: 'en', pageTitle: 'Acme', ...LINKS },
    );
    const ko = renderSubscriberMail(
      { kind: SubscriberMailKinds.confirmation },
      { locale: 'ko', pageTitle: 'Acme', ...LINKS },
    );

    expect(en.text).toContain('Confirm subscription: https://mocco.test/c?token=a');
    expect(en.text).not.toContain('token=b');
    expect(en.headers).toBeUndefined();
    expect(ko.subject).toBe('Acme 알림 구독을 확인해 주세요');
    expect(ko.html).toContain('<html lang="ko">');
  });

  it('dates a maintenance window in UTC', () => {
    const mail = renderSubscriberMail(
      {
        kind: SubscriberMailKinds.maintenance,
        title: 'DB upgrade',
        status: MaintenanceStatuses.canceled,
        body: 'Postponed.',
        components: [],
        scheduledStart: '2026-10-07T01:00:00.000Z',
        scheduledEnd: '2026-10-07T02:30:00.000Z',
      },
      { locale: 'en', pageTitle: 'Acme', ...LINKS },
    );

    expect(mail.subject).toBe('[Acme] Maintenance canceled: DB upgrade');
    expect(mail.text).toContain('Scheduled: 2026-10-07 01:00 UTC – 2026-10-07 02:30 UTC');
  });
});

describe('renderSubscriberPage', () => {
  it('escapes the page title and posts the unsubscribe form back to its own link', () => {
    const html = renderSubscriberPage(SubscriberPageKinds.unsubscribeAsk, {
      locale: 'en',
      pageTitle: '<Acme>',
      formAction: '?token=a&b',
    });

    expect(html).toContain('<title>&lt;Acme&gt;</title>');
    expect(html).toContain('<form method="post" action="?token=a&amp;b">');
  });
});
