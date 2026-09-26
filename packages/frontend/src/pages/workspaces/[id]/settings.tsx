import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import WorkspaceLayout from '@frontend/components/workspace-layout';
import WorkspaceSettings from '@frontend/components/workspace-settings';
import { WorkspaceSections } from '@frontend/lib/products';

// Workspace settings (rename + delete), client-rendered inside the workspace frame.
export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active={WorkspaceSections.settings}>
          <WorkspaceSettings workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
