import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import NotificationsPage from '@frontend/components/notifications/notifications-page';
import WorkspaceLayout from '@frontend/components/workspace-layout';

// Workspace notifications (channels, sources, activity), client-rendered inside the
// workspace frame. The tab and filters live in the query string.
export default function WorkspaceNotificationsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active="notifications">
          <NotificationsPage workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
