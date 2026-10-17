// Helpers the project's feedback console (#175) shares between its inbox, boards and post pages:
// addresses, labels and the project's help site, kept apart from the components so they stay
// fast-refreshable.
import {
  ChangelogEntryStates,
  FEEDBACK_EMAIL_END_USER_PREFIX,
  FeedbackPostSorts,
  FeedbackPostStatuses,
} from '@mocco/common/feedback';
import { Products } from '@mocco/common/project';

import { publicSiteHost } from '@frontend/components/help/help-center';
import { Tones } from '@frontend/components/notifications/notification-ui';
import { siteOrigin } from '@frontend/lib/seo';
import { trpc } from '@frontend/lib/trpc';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { ChangelogEntryState, FeedbackPostSort, FeedbackPostStatus } from '@mocco/common/feedback';

/** A board or category address from its name: `Feature requests` → `feature-requests`. */
export function feedbackSlugOf(name: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- name is a string, never null
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(word => word !== '');
  let slug = words.join('-').slice(0, 40);
  // eslint-disable-next-line sonarjs/null-dereference -- slug is a string, never null
  while (slug.endsWith('-')) {
    slug = slug.slice(0, -1);
  }
  return slug === '' ? 'ideas' : slug;
}

/** The project's help center slug, or null when it has none (or the help center is off). */
export function useHelpSiteSlug(workspaceId: string, projectId: string): string | null {
  const productsQuery = trpc.product.list.useQuery({ workspaceId });
  const hasHelp = productsQuery.data?.products.includes(Products.helpcenter) ?? false;
  const siteQuery = trpc.help.site.useQuery({ workspaceId, projectId }, { enabled: hasHelp, retry: false });
  return siteQuery.data?.site?.slug ?? null;
}

/**
 * Where a public board is served: on the app's own host for the site mounted there
 * (HELP_APP_HOST_SITE), else on the site's host; null when help sites aren't served here.
 */
export function publicBoardUrl(siteSlug: string, boardSlug: string): string | null {
  if (siteSlug === process.env.NEXT_PUBLIC_HELP_APP_HOST_SITE) {
    return `${siteOrigin()}/feedback/${boardSlug}`;
  }
  const site = publicSiteHost(siteSlug);
  return site === null ? null : `${site.url}/feedback/${boardSlug}`;
}

export const sortLabels: Record<FeedbackPostSort, string> = {
  [FeedbackPostSorts.newest]: 'Newest',
  [FeedbackPostSorts.top]: 'Most voted',
  [FeedbackPostSorts.status]: 'By status',
};

export const statusTones: Record<FeedbackPostStatus, Tone> = {
  [FeedbackPostStatuses.underReview]: Tones.neutral,
  [FeedbackPostStatuses.planned]: Tones.ok,
  [FeedbackPostStatuses.inProgress]: Tones.warn,
  [FeedbackPostStatuses.shipped]: Tones.ok,
  [FeedbackPostStatuses.closed]: Tones.neutral,
};

/** An end user as the team sees them: an email voter's address, else the app's user id. */
export const endUserLabel = (endUserId: string) =>
  // eslint-disable-next-line sonarjs/null-dereference -- endUserId is a string, never null
  endUserId.startsWith(FEEDBACK_EMAIL_END_USER_PREFIX)
    ? endUserId.slice(FEEDBACK_EMAIL_END_USER_PREFIX.length)
    : endUserId;

export const changelogStateLabels: Record<ChangelogEntryState, string> = {
  [ChangelogEntryStates.draft]: 'Draft',
  [ChangelogEntryStates.scheduled]: 'Scheduled',
  [ChangelogEntryStates.published]: 'Published',
};

export const changelogStateTones: Record<ChangelogEntryState, Tone> = {
  [ChangelogEntryStates.draft]: Tones.neutral,
  [ChangelogEntryStates.scheduled]: Tones.warn,
  [ChangelogEntryStates.published]: Tones.ok,
};

/** "Oct 17, 2026, 9:30 AM" in the viewer's time zone. */
export const formatWhen = (date: Date) => date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
