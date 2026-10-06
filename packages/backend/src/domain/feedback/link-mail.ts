// What feedback's email-only voters are sent (#174): the mail that confirms their address, and
// the small pages its confirm and unsubscribe links open. Pure functions; every customer string
// (a post's title) is escaped in HTML.
import { escapeHtml } from '@backend/domain/status/snapshot/render';

import type { EmailMessage } from '@backend/domain/notification/senders/email';

/** The mail that confirms an email-only vote. */
export function renderIdentifyMail(opts: {
  to: string;
  postTitle: string;
  confirmUrl: string;
  unsubscribeUrl: string;
}): EmailMessage {
  const subject = `Confirm your vote on "${opts.postTitle}"`;
  const intro = `Someone, hopefully you, voted for "${opts.postTitle}" with this address. Confirm it and the vote counts.`;
  const ignore = "If it wasn't you, ignore this mail: the vote won't count. The link works for a day.";
  const unsubscribe = 'Stop hearing about this post';
  return {
    to: opts.to,
    subject,
    text: [intro, '', `Confirm: ${opts.confirmUrl}`, '', ignore, '', `${unsubscribe}: ${opts.unsubscribeUrl}`].join(
      '\n',
    ),
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(opts.confirmUrl)}">Confirm my vote</a></p><p>${escapeHtml(ignore)}</p><p><a href="${escapeHtml(opts.unsubscribeUrl)}">${escapeHtml(unsubscribe)}</a></p>`,
    headers: {
      'List-Unsubscribe': `<${opts.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

export const FeedbackLinkPageKinds = {
  confirmed: 'confirmed',
  unsubscribeAsk: 'unsubscribe_ask',
  unsubscribed: 'unsubscribed',
  invalid: 'invalid',
} as const;
export type FeedbackLinkPageKind = (typeof FeedbackLinkPageKinds)[keyof typeof FeedbackLinkPageKinds];

const votesCounted = (count: number) => {
  if (count === 0) {
    return 'Your address is confirmed. Your votes count.';
  }
  return count === 1
    ? 'Your address is confirmed: your vote counts now.'
    : `Your address is confirmed: your ${count} votes count now.`;
};

/** A page a link opens. `formAction` is where the unsubscribe question posts. */
export function renderLinkPage(
  kind: FeedbackLinkPageKind,
  opts: { postTitle?: string; counted?: number; formAction?: string } = {},
): string {
  const post = `"${opts.postTitle ?? ''}"`;
  const message = {
    [FeedbackLinkPageKinds.confirmed]: votesCounted(opts.counted ?? 0),
    [FeedbackLinkPageKinds.unsubscribeAsk]: `Stop getting mail about ${post}?`,
    [FeedbackLinkPageKinds.unsubscribed]: `You won't get mail about ${post} any more.`,
    [FeedbackLinkPageKinds.invalid]: "This link isn't valid any more.",
  }[kind];
  const form =
    kind === FeedbackLinkPageKinds.unsubscribeAsk && opts.formAction !== undefined
      ? `<form method="post" action="${escapeHtml(opts.formAction)}"><button type="submit">Unsubscribe</button></form>`
      : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Feedback</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.5rem 1rem}</style></head><body><p>${escapeHtml(message)}</p>${form}</body></html>`;
}
