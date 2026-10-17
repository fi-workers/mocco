// What feedback's email-only voters are sent (#174): the mail that confirms their address, and
// the small pages its confirm and unsubscribe links open. Pure functions; every customer string
// (a post's title) is escaped in HTML.
import { escapeHtml } from '@backend/domain/status/snapshot/render';

import type { EmailMessage } from '@backend/domain/notification/senders/email';

/** The mail that confirms an email-only vote. It goes out even to an address that stopped all of
 * the project's feedback mail: someone just voted with it, and the vote can't count without it. */
export function renderIdentifyMail(opts: {
  to: string;
  postTitle: string;
  projectName: string;
  confirmUrl: string;
  unsubscribeUrl: string;
  unsubscribeAllUrl: string;
}): EmailMessage {
  const subject = `Confirm your vote on "${opts.postTitle}"`;
  const intro = `Someone, hopefully you, voted for "${opts.postTitle}" with this address. Confirm it and the vote counts.`;
  const ignore = "If it wasn't you, ignore this mail: the vote won't count. The link works for a day.";
  const unsubscribe = 'Stop hearing about this post';
  const unsubscribeAll = `Stop all mail about ${opts.projectName}'s feedback`;
  return {
    to: opts.to,
    subject,
    text: [
      intro,
      '',
      `Confirm: ${opts.confirmUrl}`,
      '',
      ignore,
      '',
      `${unsubscribe}: ${opts.unsubscribeUrl}`,
      `${unsubscribeAll}: ${opts.unsubscribeAllUrl}`,
    ].join('\n'),
    html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(opts.confirmUrl)}">Confirm my vote</a></p><p>${escapeHtml(ignore)}</p><p><a href="${escapeHtml(opts.unsubscribeUrl)}">${escapeHtml(unsubscribe)}</a> · <a href="${escapeHtml(opts.unsubscribeAllUrl)}">${escapeHtml(unsubscribeAll)}</a></p>`,
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
  unsubscribeAllAsk: 'unsubscribe_all_ask',
  unsubscribedAll: 'unsubscribed_all',
  mailResumed: 'mail_resumed',
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

export interface LinkPageOptions {
  postTitle?: string;
  projectName?: string;
  counted?: number;
  /** Where the page's question posts: unsubscribing, or turning mail back on. */
  formAction?: string;
  /** The unsubscribe question's second form, which stops all of the project's mail. */
  allFormAction?: string;
}

const formOf = (action: string | undefined, label: string) =>
  action === undefined
    ? ''
    : `<form method="post" action="${escapeHtml(action)}"><button type="submit">${escapeHtml(label)}</button></form>`;

/** A page a link opens. Every action is a form that posts: opening a link only asks. */
export function renderLinkPage(kind: FeedbackLinkPageKind, opts: LinkPageOptions = {}): string {
  const post = `"${opts.postTitle ?? ''}"`;
  const feedback = `${opts.projectName ?? 'this project'}'s feedback`;
  const isConfirmedAsking = kind === FeedbackLinkPageKinds.confirmed && opts.formAction !== undefined;
  const stopped = `You stopped all mail about ${feedback}, so you won't hear when the posts you voted for move.`;
  const stopAll = `Stop all mail about ${feedback}`;
  const message = {
    [FeedbackLinkPageKinds.confirmed]: votesCounted(opts.counted ?? 0),
    [FeedbackLinkPageKinds.unsubscribeAsk]: `Stop getting mail about ${post}?`,
    [FeedbackLinkPageKinds.unsubscribed]: `You won't get mail about ${post} any more.`,
    [FeedbackLinkPageKinds.unsubscribeAllAsk]: `Stop all mail about ${feedback}? You won't hear when any post you voted for moves.`,
    [FeedbackLinkPageKinds.unsubscribedAll]: `You won't get mail about ${feedback} any more. If you vote by email again, you'll get the mail that confirms it, and can turn the rest back on from there.`,
    [FeedbackLinkPageKinds.mailResumed]: `You'll hear about ${feedback} again when the posts you follow move.`,
    [FeedbackLinkPageKinds.invalid]: "This link isn't valid any more.",
  }[kind];
  const forms = {
    [FeedbackLinkPageKinds.confirmed]: isConfirmedAsking
      ? `<p>${escapeHtml(stopped)}</p>${formOf(opts.formAction, 'Mail me about it again')}`
      : '',
    [FeedbackLinkPageKinds.unsubscribeAsk]:
      formOf(opts.formAction, 'Unsubscribe') + formOf(opts.allFormAction, stopAll),
    [FeedbackLinkPageKinds.unsubscribed]: '',
    [FeedbackLinkPageKinds.unsubscribeAllAsk]: formOf(opts.formAction, 'Stop all mail'),
    [FeedbackLinkPageKinds.unsubscribedAll]: '',
    [FeedbackLinkPageKinds.mailResumed]: '',
    [FeedbackLinkPageKinds.invalid]: '',
  }[kind];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Feedback</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}form{margin:.75rem 0}button{font:inherit;padding:.5rem 1rem}</style></head><body><p>${escapeHtml(message)}</p>${forms}</body></html>`;
}
