import { useRouter } from 'next/router';

import AppShell from '@/components/app-shell';
import WorkspaceLayout from '@/components/workspace-layout';

// Workspace settings (placeholder — rename/delete lands with the update mutations).
export default function WorkspaceSettingsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active="settings">
          <div className="flex flex-col gap-4">
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">Renaming and deleting this workspace lands here soon.</p>
          </div>
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
