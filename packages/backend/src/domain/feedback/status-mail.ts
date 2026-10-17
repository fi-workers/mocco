// The mail a post's followers get when it moves (#180): planned, in progress, shipped or closed.
// Pure: StatusMailService fills in the links. Every customer string (the post's title, the
// project's name) is escaped in HTML, and every mail carries the one-click unsubscribe link and
// the link that stops all of the project's feedback mail.
import { FeedbackPostStatuses } from '@mocco/common/feedback';

import { escapeHtml } from '@backend/domain/status/snapshot/render';

import type { EmailMessage } from '@backend/domain/notification/senders/email';
import type { FeedbackPostStatus } from '@mocco/common/feedback';

type NotifiedStatus = Exclude<FeedbackPostStatus, typeof FeedbackPostStatuses.underReview>;

const headlines: Record<NotifiedStatus, (title: string) => { subject: string; line: string }> = {
  [FeedbackPostStatuses.planned]: title => ({
    subject: `"${title}" is planned`,
    line: `Good news: "${title}", which you voted for, is planned.`,
  }),
  [FeedbackPostStatuses.inProgress]: title => ({
    subject: `Work has started on "${title}"`,
    line: `Work has started on "${title}", which you voted for.`,
  }),
  [FeedbackPostStatuses.shipped]: title => ({
    subject: `"${title}" has shipped`,
    line: `"${title}", which you voted for, has shipped.`,
  }),
  [FeedbackPostStatuses.closed]: title => ({
    subject: `"${title}" was closed`,
    line: `"${title}", which you voted for, was closed. Thanks for telling us what you need.`,
  }),
};

export interface StatusMailInput {
  to: string;
  projectName: string;
  postTitle: string;
  status: NotifiedStatus;
  /** The post's public page, or null when the project has no public site. */
  postUrl: string | null;
  /** The changelog entry that announced it, when it shipped in one. */
  changelogUrl: string | null;
  unsubscribeUrl: string;
  /** The same signed link's page that stops all mail about the project's feedback. */
  unsubscribeAllUrl: string;
}

export function renderStatusMail(input: StatusMailInput): EmailMessage {
  const { subject, line } = headlines[input.status](input.postTitle);
  const footer = `You get this because you voted for it on ${input.projectName}'s feedback board.`;
  const unsubscribe = 'Stop hearing about this post';
  const unsubscribeAll = `Stop all mail about ${input.projectName}'s feedback`;
  const links: { label: string; url: string }[] = [
    ...(input.changelogUrl === null ? [] : [{ label: 'Read what shipped', url: input.changelogUrl }]),
    ...(input.postUrl === null ? [] : [{ label: 'See the post', url: input.postUrl }]),
  ];
  return {
    to: input.to,
    subject,
    text: [
      line,
      '',
      ...links.map(link => `${link.label}: ${link.url}`),
      ...(links.length === 0 ? [] : ['']),
      footer,
      `${unsubscribe}: ${input.unsubscribeUrl}`,
      `${unsubscribeAll}: ${input.unsubscribeAllUrl}`,
    ].join('\n'),
    html: [
      `<p>${escapeHtml(line)}</p>`,
      ...links.map(link => `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>`),
      `<p>${escapeHtml(footer)}</p>`,
      `<p><a href="${escapeHtml(input.unsubscribeUrl)}">${escapeHtml(unsubscribe)}</a> · <a href="${escapeHtml(input.unsubscribeAllUrl)}">${escapeHtml(unsubscribeAll)}</a></p>`,
    ].join(''),
    headers: {
      'List-Unsubscribe': `<${input.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}
