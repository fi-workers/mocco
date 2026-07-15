import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import WorkspaceLayout from '@frontend/components/workspace-layout';
import WorkspaceMembers from '@frontend/components/workspace-members';

// Workspace members (read-only list), client-rendered inside the workspace frame.
export default function WorkspaceMembersPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active="members">
          <WorkspaceMembers workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
