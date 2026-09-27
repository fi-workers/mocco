import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import WorkspaceLayout from '@frontend/components/workspace-layout';
import WorkspaceProjects from '@frontend/components/workspace-projects';
import { WorkspaceSections } from '@frontend/lib/products';

// Workspace → Projects, client-rendered inside the workspace frame.
export default function WorkspaceProjectsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active={WorkspaceSections.projects}>
          <WorkspaceProjects workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
