import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { cn } from '@frontend/lib/utils';

import type { ReactNode } from 'react';

type Section = 'overview' | 'members' | 'settings';

interface Props {
  workspaceId: string;
  active: Section;
  children: ReactNode;
}

// The workspace-scoped frame: a left nav (overview / members / settings) beside
// the section content, shown inside the global AppShell. Entering any workspace
// page makes it active server-side (which also validates membership — a
// workspace the user isn't in bounces to /workspaces).
export default function WorkspaceLayout({ workspaceId, active, children }: Props) {
  const router = useRouter();
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

  useEffect(() => {
    setActive({ workspaceId });
  }, [workspaceId, setActive]);

  const workspace = listQuery.data?.workspaces.find(ws => ws.id === workspaceId);
  const nav: { key: Section; label: string; href: string }[] = [
    { key: 'overview', label: 'Overview', href: Routes.workspace(workspaceId) },
    { key: 'members', label: 'Members', href: Routes.workspaceMembers(workspaceId) },
    { key: 'settings', label: 'Settings', href: Routes.workspaceSettings(workspaceId) },
  ];

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
