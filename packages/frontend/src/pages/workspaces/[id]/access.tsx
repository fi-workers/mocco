import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import WorkspaceAccess from '@frontend/components/workspace-access';
import WorkspaceLayout from '@frontend/components/workspace-layout';

// Workspace access (roles & memberships), client-rendered inside the workspace frame.
export default function WorkspaceAccessPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active="access">
          <WorkspaceAccess workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
