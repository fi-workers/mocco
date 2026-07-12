import { useRouter } from 'next/router';

import AppShell from '@/components/app-shell';
import WorkspaceLayout from '@/components/workspace-layout';
import WorkspaceSettings from '@/components/workspace-settings';

// Workspace settings (rename + delete), client-rendered inside the workspace frame.
export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active="settings">
          <WorkspaceSettings workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
