import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import WorkspaceLayout from '@frontend/components/workspace-layout';
import WorkspaceProducts from '@frontend/components/workspace-products';
import { WorkspaceSections } from '@frontend/lib/products';

// Workspace → Products, client-rendered inside the workspace frame.
export default function WorkspaceProductsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  return (
    <AppShell>
      {id ? (
        <WorkspaceLayout workspaceId={id} active={WorkspaceSections.products}>
          <WorkspaceProducts workspaceId={id} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
