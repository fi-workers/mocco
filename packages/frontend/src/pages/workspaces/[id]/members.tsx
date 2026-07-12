import { useRouter } from 'next/router';

import AppShell from '@/components/app-shell';
import WorkspaceLayout from '@/components/workspace-layout';

// Workspace members (placeholder — invite/manage lands with the members mutations).
export default function WorkspaceMembersPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active="members">
          <div className="flex flex-col gap-4">
            <h1 className="text-xl font-semibold tracking-tight">Members</h1>
            <p className="text-sm text-muted-foreground">Inviting and managing members lands here soon.</p>
          </div>
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
