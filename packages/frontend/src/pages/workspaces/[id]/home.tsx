import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import WorkspaceHome from '@frontend/components/workspace-home';
import WorkspaceLayout from '@frontend/components/workspace-layout';
import { WorkspaceSections } from '@frontend/lib/products';

// A workspace's Home: approvals waiting across products, recent activity, projects.
// The workspace id is the path.
export default function WorkspaceHomePage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active={WorkspaceSections.home}>
          <WorkspaceHome workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
