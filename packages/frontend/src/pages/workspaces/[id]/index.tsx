import { useRouter } from 'next/router';

import AppShell from '@/components/app-shell';
import WorkspaceLayout from '@/components/workspace-layout';
import WorkspaceOverview from '@/components/workspace-overview';

// A workspace's Overview (its repos), client-rendered inside the workspace frame.
export default function WorkspaceOverviewPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active="overview">
          <WorkspaceOverview />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
