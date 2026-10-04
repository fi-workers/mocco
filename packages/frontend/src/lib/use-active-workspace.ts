import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

/**
 * Makes the workspace in the path the active one server-side (which also validates
 * membership — a workspace the user isn't in bounces to /workspaces) and returns it
 * from the workspace list. Every workspace- and project-scoped layout calls it.
 */
export function useActiveWorkspace(workspaceId: string): { workspace: { id: string; name: string } | undefined } {
  const router = useRouter();
  const utils = trpc.useUtils();
  const listQuery = trpc.workspace.list.useQuery();
  const { mutate: setActive } = trpc.workspace.setActive.useMutation({
    // Optimistically point the active-workspace cache at the target so the top-bar
    // switcher label (AppShell reads workspace.active) flips as soon as this page
    // mounts, instead of lagging a setActive round-trip + refetch behind the nav.
    // members is filled in by the onSuccess refetch — AppShell only reads id/name.
    onMutate: async ({ workspaceId: targetId }) => {
      await utils.workspace.active.cancel();
      const previous = utils.workspace.active.getData();
      const target = listQuery.data?.workspaces.find(ws => ws.id === targetId);
      if (target) {
        utils.workspace.active.setData(undefined, { workspace: { ...target, members: [] } });
      }
      return { previous };
    },
    onSuccess: () => {
      fireAndForget(utils.workspace.active.invalidate());
    },
    onError: (_error, _variables, context) => {
      // Roll back the optimistic value to the server truth, then bounce — a
      // failed setActive means the user isn't a member of this workspace.
      if (context) {
        utils.workspace.active.setData(undefined, context.previous);
      }
      fireAndForget(router.replace(Routes.workspaces));
    },
  });

  useEffect(() => {
    setActive({ workspaceId });
  }, [workspaceId, setActive]);

  return { workspace: listQuery.data?.workspaces.find(ws => ws.id === workspaceId) };
}
