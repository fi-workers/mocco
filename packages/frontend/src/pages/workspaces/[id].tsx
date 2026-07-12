import { useRouter } from 'next/router';
import { useEffect } from 'react';

import AppShell from '@/components/app-shell';
import WorkspaceDashboard from '@/components/workspace-dashboard';
import { fireAndForget } from '@/lib/fire-and-forget';
import { Routes } from '@/lib/routes';
import { trpc } from '@/lib/trpc';

// A workspace's dashboard (its repos + deploy governance), client-rendered.
export default function WorkspaceDashboardPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;

  const utils = trpc.useUtils();
  const listQuery = trpc.workspace.list.useQuery();
  const { mutate: setActive } = trpc.workspace.setActive.useMutation({
    onSuccess: () => {
      fireAndForget(utils.workspace.active.invalidate());
    },
    onError: () => {
      fireAndForget(router.replace(Routes.workspaces));
    },
  });

  // Visiting a dashboard makes its workspace active server-side (keeping the
  // switcher and next login in sync); setActive also validates membership, so a
  // workspace the user isn't in bounces to /workspaces.
  useEffect(() => {
    if (id) {
      setActive({ workspaceId: id });
    }
  }, [id, setActive]);

  const workspace = listQuery.data?.workspaces.find(ws => ws.id === id);

  return (
    <AppShell>
      <WorkspaceDashboard name={workspace?.name ?? 'Workspace'} />
    </AppShell>
  );
}
