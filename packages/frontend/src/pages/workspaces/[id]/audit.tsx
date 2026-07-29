import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import WorkspaceAudit from '@frontend/components/workspace-audit';
import WorkspaceLayout from '@frontend/components/workspace-layout';

// Workspace audit log (the tamper-evident hash chain), client-rendered inside the
// workspace frame.
export default function WorkspaceAuditPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active="audit">
          <WorkspaceAudit workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
