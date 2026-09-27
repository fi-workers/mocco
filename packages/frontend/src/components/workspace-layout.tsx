import { Products } from '@mocco/common/project';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { visibleEntries, workspaceNav } from '@frontend/lib/products';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { cn } from '@frontend/lib/utils';

import type { WorkspaceSection } from '@frontend/lib/products';
import type { ReactNode } from 'react';

interface Props {
  workspaceId: string;
  active: WorkspaceSection;
  children: ReactNode;
}

// The workspace-scoped frame: a left nav (the product registry's workspace sections,
// filtered by the workspace's enabled products) beside the section content, shown inside the global AppShell. Entering any workspace
// page makes it active server-side (which also validates membership — a
// workspace the user isn't in bounces to /workspaces).
export default function WorkspaceLayout({ workspaceId, active, children }: Props) {
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

  const workspace = listQuery.data?.workspaces.find(ws => ws.id === workspaceId);
  // Until the enabled products load, governance (always on) is the safe assumption.
  const productsQuery = trpc.product.list.useQuery({ workspaceId });
  const nav = visibleEntries(workspaceNav, productsQuery.data?.products ?? [Products.governance]).map(entry => ({
    key: entry.key,
    label: entry.label,
    href: entry.href(workspaceId),
  }));

  return (
    <div className="flex flex-1">
      <aside className="w-56 shrink-0 border-r border-border px-3 py-6">
        <div className="mb-4 flex items-center gap-2 px-2">
          <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
            {(workspace?.name ?? '?').charAt(0).toUpperCase()}
          </div>
          <span className="truncate text-sm font-medium">{workspace?.name ?? 'Workspace'}</span>
        </div>
        <nav className="flex flex-col gap-0.5">
          {nav.map(item => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={item.key === active ? 'page' : undefined}
              className={cn(
                'rounded-lg px-3 py-2 text-sm font-medium transition',
                item.key === active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1 px-8 py-8">
        <div className="mx-auto max-w-4xl">{children}</div>
      </div>
    </div>
  );
}
