import { inboundOutcomeSchema } from '@mocco/common/inbound';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { z } from 'zod';

import NotificationActivity from '@frontend/components/notifications/notification-activity';
import NotificationChannels from '@frontend/components/notifications/notification-channels';
import NotificationSources from '@frontend/components/notifications/notification-sources';
import { Notice, Tones } from '@frontend/components/notifications/notification-ui';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { useWorkspaceAdmin } from '@frontend/lib/use-workspace-admin';
import { cn } from '@frontend/lib/utils';

import type { ActivityFilters } from '@frontend/components/notifications/notification-activity';
import type { ParsedUrlQuery } from 'node:querystring';

const NotificationTabs = {
  channels: 'channels',
  sources: 'sources',
  activity: 'activity',
} as const;
type NotificationTab = (typeof NotificationTabs)[keyof typeof NotificationTabs];
const tabSchema = z.enum([NotificationTabs.channels, NotificationTabs.sources, NotificationTabs.activity]);

const TAB_LABELS: Record<NotificationTab, string> = {
  [NotificationTabs.channels]: 'Channels',
  [NotificationTabs.sources]: 'Sources',
  [NotificationTabs.activity]: 'Activity',
};

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** The view state in the URL: `?tab=`, the activity filters, and the Discord install's `connect_error=1`. */
function parseQuery(query: ParsedUrlQuery) {
  const tab = tabSchema.safeParse(first(query.tab));
  const sourceId = z.uuid().safeParse(first(query.source));
  const channelId = z.uuid().safeParse(first(query.channel));
  const outcome = inboundOutcomeSchema.safeParse(first(query.outcome));
  const filters: ActivityFilters = {
    ...(sourceId.success && { sourceId: sourceId.data }),
    ...(channelId.success && { channelId: channelId.data }),
    ...(outcome.success && { outcome: outcome.data }),
  };
  return {
    tab: tab.success ? tab.data : NotificationTabs.channels,
    filters,
    connectError: first(query.connect_error) === '1',
  };
}

/**
 * The Notifications screen: Channels (connect Discord, channels and their rules), Sources
 * (webhook sources) and Activity (the trace). The tab and the activity filters are in the
 * URL, so a link opens the same view. Non-admins see everything read-only.
 */
export default function NotificationsPage({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const { isAdmin } = useWorkspaceAdmin(workspaceId);
  const { tab, filters, connectError } = parseQuery(router.query);
  const base = Routes.workspaceNotifications(workspaceId);

  const tabHref = (target: NotificationTab) => `${base}?tab=${target}`;

  const setFilters = (next: ActivityFilters) => {
    const params = new URLSearchParams({ tab: NotificationTabs.activity });
    if (next.sourceId !== undefined) {
      params.set('source', next.sourceId);
    }
    if (next.channelId !== undefined) {
      params.set('channel', next.channelId);
    }
    if (next.outcome !== undefined) {
      params.set('outcome', next.outcome);
    }
    fireAndForget(router.push(`${base}?${params.toString()}`, undefined, { shallow: true }));
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Post Mocco, Sentry, Vercel and GitHub events to Discord.{' '}
          <Link href={Routes.notificationsGuide('overview')} className="underline underline-offset-2">
            Read the guide
          </Link>
          {isAdmin ? null : ' · You have read-only access; owners and admins can change these settings.'}
        </p>
      </div>

      <nav aria-label="Notification sections" className="flex gap-1 border-b border-border">
        {tabSchema.options.map(option => (
          <Link
            key={option}
            href={tabHref(option)}
            shallow
            aria-current={option === tab ? 'page' : undefined}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
              option === tab
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}>
            {TAB_LABELS[option]}
          </Link>
        ))}
      </nav>

      {connectError && tab === NotificationTabs.channels ? (
        <Notice tone={Tones.danger} title="Discord was not connected">
          Discord did not finish the install. Try Connect Discord again; if it keeps failing, check that you picked a
          server you can manage.
        </Notice>
      ) : null}

      {tab === NotificationTabs.channels ? <NotificationChannels workspaceId={workspaceId} isAdmin={isAdmin} /> : null}
      {tab === NotificationTabs.sources ? <NotificationSources workspaceId={workspaceId} isAdmin={isAdmin} /> : null}
      {tab === NotificationTabs.activity ? (
        <NotificationActivity workspaceId={workspaceId} filters={filters} onFiltersChange={setFilters} />
      ) : null}
    </div>
  );
}
