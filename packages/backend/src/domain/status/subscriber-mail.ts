// What subscribers are sent (#156), in English and Korean: the double opt-in mail, an incident
// update and a maintenance change, plus the small pages the confirm and unsubscribe links open.
// Pure functions; every customer string is escaped in HTML. The Korean strings are product copy
// shown to Korean subscribers, kept together in `STRINGS`.
import {
  IncidentStatuses,
  incidentStatusSchema,
  MaintenanceStatuses,
  SubscriberLocales,
  SubscriberMailKinds,
} from '@mocco/common/status';
import { z } from 'zod';

import { escapeHtml } from '@backend/domain/status/snapshot/render';

import type { EmailMessage } from '@backend/domain/notification/senders/email';
import type { IncidentStatus, MaintenanceStatus, SubscriberLocale } from '@mocco/common/status';

export const maintenanceStatusSchema = z.enum(
  Object.values(MaintenanceStatuses) as [MaintenanceStatus, ...MaintenanceStatus[]],
);

/** What a delivery's mail says, captured at fan-out (`content` of the delivery row). */
export const subscriberMailContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal(SubscriberMailKinds.confirmation) }),
  z.object({
    kind: z.literal(SubscriberMailKinds.incidentUpdate),
    incidentTitle: z.string(),
    status: incidentStatusSchema,
    body: z.string(),
    components: z.array(z.string()),
    postedAt: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal(SubscriberMailKinds.maintenance),
    title: z.string(),
    status: maintenanceStatusSchema,
    body: z.string(),
    components: z.array(z.string()),
    scheduledStart: z.iso.datetime(),
    scheduledEnd: z.iso.datetime(),
  }),
]);
export type SubscriberMailContent = z.infer<typeof subscriberMailContentSchema>;

interface Strings {
  confirmSubject: (page: string) => string;
  confirmIntro: (page: string) => string;
  confirmAction: string;
  confirmIgnore: string;
  incident: Record<IncidentStatus, string>;
  maintenance: Record<MaintenanceStatus, string>;
  affects: string;
  scheduled: string;
  footer: (page: string) => string;
  unsubscribe: string;
  pages: {
    confirmed: (page: string) => string;
    unsubscribeAsk: (page: string) => string;
    unsubscribeButton: string;
    unsubscribed: (page: string) => string;
    invalid: string;
  };
}

const STRINGS: Record<SubscriberLocale, Strings> = {
  [SubscriberLocales.en]: {
    confirmSubject: page => `Confirm your subscription to ${page}`,
    confirmIntro: page => `Someone, hopefully you, asked to get updates from ${page} at this address.`,
    confirmAction: 'Confirm subscription',
    confirmIgnore:
      "If it wasn't you, ignore this mail: nothing more is sent unless the link is opened. The link works for 7 days.",
    incident: {
      [IncidentStatuses.investigating]: 'Investigating',
      [IncidentStatuses.identified]: 'Identified',
      [IncidentStatuses.monitoring]: 'Monitoring',
      [IncidentStatuses.resolved]: 'Resolved',
    },
    maintenance: {
      [MaintenanceStatuses.scheduled]: 'Scheduled maintenance',
      [MaintenanceStatuses.inProgress]: 'Maintenance in progress',
      [MaintenanceStatuses.completed]: 'Maintenance completed',
      [MaintenanceStatuses.canceled]: 'Maintenance canceled',
    },
    affects: 'Affects',
    scheduled: 'Scheduled',
    footer: page => `You get this mail because you subscribed to updates from ${page}.`,
    unsubscribe: 'Unsubscribe',
    pages: {
      confirmed: page => `You're subscribed to updates from ${page}.`,
      unsubscribeAsk: page => `Stop getting updates from ${page} at this address?`,
      unsubscribeButton: 'Unsubscribe',
      unsubscribed: page => `You won't get updates from ${page} any more.`,
      invalid: "This link isn't valid any more. Subscribe again from the status page.",
    },
  },
  [SubscriberLocales.ko]: {
    confirmSubject: page => `${page} 알림 구독을 확인해 주세요`,
    confirmIntro: page => `이 주소로 ${page} 알림을 받겠다는 요청이 있었습니다.`,
    confirmAction: '구독 확인',
    confirmIgnore:
      '직접 요청하지 않았다면 이 메일을 무시하세요. 링크를 열지 않으면 더 이상 메일을 보내지 않습니다. 링크는 7일 동안 유효합니다.',
    incident: {
      [IncidentStatuses.investigating]: '조사 중',
      [IncidentStatuses.identified]: '원인 파악',
      [IncidentStatuses.monitoring]: '모니터링 중',
      [IncidentStatuses.resolved]: '해결됨',
    },
    maintenance: {
      [MaintenanceStatuses.scheduled]: '점검 예정',
      [MaintenanceStatuses.inProgress]: '점검 진행 중',
      [MaintenanceStatuses.completed]: '점검 완료',
      [MaintenanceStatuses.canceled]: '점검 취소',
    },
    affects: '영향 범위',
    scheduled: '일정',
    footer: page => `${page} 알림을 구독하셔서 이 메일을 받으셨습니다.`,
    unsubscribe: '구독 해지',
    pages: {
      confirmed: page => `${page} 알림 구독이 완료되었습니다.`,
      unsubscribeAsk: page => `이 주소로 받던 ${page} 알림을 그만 받으시겠습니까?`,
      unsubscribeButton: '구독 해지',
      unsubscribed: page => `더 이상 ${page} 알림을 보내지 않습니다.`,
      invalid: '더 이상 유효하지 않은 링크입니다. 상태 페이지에서 다시 구독해 주세요.',
    },
  },
};

/** `2026-10-05 09:00 UTC`: mail has no viewer time zone, so times are UTC and say so. */
function utc(iso: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- iso is a string
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const paragraphs = (text: string) =>
  // eslint-disable-next-line sonarjs/null-dereference -- text is a string
  text
    .split(/\n{2,}/u)
    .map(part => `<p>${escapeHtml(part).replaceAll('\n', '<br>')}</p>`)
    .join('');

interface Rendered {
  subject: string;
  /** The mail's paragraphs, plain text. */
  lines: string[];
  /** The one link the mail is about, if any. */
  action?: { label: string; url: string };
}

function renderContent(content: SubscriberMailContent, strings: Strings, page: string, confirmUrl: string): Rendered {
  switch (content.kind) {
    case SubscriberMailKinds.confirmation: {
      return {
        subject: strings.confirmSubject(page),
        lines: [strings.confirmIntro(page), strings.confirmIgnore],
        action: { label: strings.confirmAction, url: confirmUrl },
      };
    }
    case SubscriberMailKinds.incidentUpdate: {
      const label = strings.incident[content.status];
      return {
        subject: `[${page}] ${label}: ${content.incidentTitle}`,
        lines: [
          `${content.incidentTitle}: ${label}`,
          content.body,
          ...(content.components.length > 0 ? [`${strings.affects}: ${content.components.join(', ')}`] : []),
          utc(content.postedAt),
        ],
      };
    }
    case SubscriberMailKinds.maintenance: {
      const label = strings.maintenance[content.status];
      return {
        subject: `[${page}] ${label}: ${content.title}`,
        lines: [
          `${content.title}: ${label}`,
          content.body,
          `${strings.scheduled}: ${utc(content.scheduledStart)} – ${utc(content.scheduledEnd)}`,
          ...(content.components.length > 0 ? [`${strings.affects}: ${content.components.join(', ')}`] : []),
        ],
      };
    }
    default: {
      const unexpected: never = content;
      throw new Error(`unexpected subscriber mail ${JSON.stringify(unexpected)}`);
    }
  }
}

/**
 * The mail for one delivery. A confirmation carries its confirm link and nothing else; every
 * other mail carries the unsubscribe link in its footer and in `List-Unsubscribe`, with
 * `List-Unsubscribe-Post` for one-click unsubscribing (RFC 8058).
 */
export function renderSubscriberMail(
  content: SubscriberMailContent,
  opts: { locale: SubscriberLocale; pageTitle: string; confirmUrl: string; unsubscribeUrl: string },
): Omit<EmailMessage, 'to'> {
  const strings = STRINGS[opts.locale];
  const { subject, lines, action } = renderContent(content, strings, opts.pageTitle, opts.confirmUrl);
  const isConfirmation = content.kind === SubscriberMailKinds.confirmation;
  const footer = isConfirmation
    ? []
    : [strings.footer(opts.pageTitle), `${strings.unsubscribe}: ${opts.unsubscribeUrl}`];
  const text = [...lines, ...(action === undefined ? [] : [`${action.label}: ${action.url}`]), ...footer].join('\n\n');
  const actionHtml =
    action === undefined ? '' : `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>`;
  const footerHtml = isConfirmation
    ? ''
    : `<hr><p style="color:#666;font-size:12px">${escapeHtml(strings.footer(opts.pageTitle))} <a href="${escapeHtml(opts.unsubscribeUrl)}">${escapeHtml(strings.unsubscribe)}</a></p>`;
  const html = `<!doctype html><html lang="${opts.locale}"><body style="font-family:system-ui,sans-serif;line-height:1.5">${lines.map(line => paragraphs(line)).join('')}${actionHtml}${footerHtml}</body></html>`;
  return {
    subject,
    text,
    html,
    ...(!isConfirmation && {
      headers: {
        'List-Unsubscribe': `<${opts.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  };
}

/** What a confirm or unsubscribe link opens. */
export const SubscriberPageKinds = {
  confirmed: 'confirmed',
  unsubscribeAsk: 'unsubscribe_ask',
  unsubscribed: 'unsubscribed',
  invalid: 'invalid',
} as const;
export type SubscriberPageKind = (typeof SubscriberPageKinds)[keyof typeof SubscriberPageKinds];

/** The small HTML page a link from the mail opens. The unsubscribe link asks first, with a form
 * that POSTs back, so a mail scanner fetching links doesn't unsubscribe anyone. */
export function renderSubscriberPage(
  kind: SubscriberPageKind,
  opts: { locale: SubscriberLocale; pageTitle: string; formAction?: string },
): string {
  const strings = STRINGS[opts.locale].pages;
  const message = {
    [SubscriberPageKinds.confirmed]: strings.confirmed(opts.pageTitle),
    [SubscriberPageKinds.unsubscribeAsk]: strings.unsubscribeAsk(opts.pageTitle),
    [SubscriberPageKinds.unsubscribed]: strings.unsubscribed(opts.pageTitle),
    [SubscriberPageKinds.invalid]: strings.invalid,
  }[kind];
  const form =
    kind === SubscriberPageKinds.unsubscribeAsk && opts.formAction !== undefined
      ? `<form method="post" action="${escapeHtml(opts.formAction)}"><button type="submit">${escapeHtml(strings.unsubscribeButton)}</button></form>`
      : '';
  const title = escapeHtml(opts.pageTitle);
  return `<!doctype html><html lang="${opts.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.5rem 1rem}</style></head><body><h1>${title}</h1><p>${escapeHtml(message)}</p>${form}</body></html>`;
}
