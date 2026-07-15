import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

import UserMenu from '@frontend/components/user-menu';
import WorkspaceSwitcher from '@frontend/components/workspace-switcher';
import { useSession } from '@frontend/lib/auth-client';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { ReactNode } from 'react';

// The authenticated app layout (client-rendered): guards the session, fetches
// the shell data with React Query, and frames the page in a Vercel-style top bar
// (logo + workspace switcher on the left, the signed-in user on the right).
export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: session, isPending } = useSession();

  useEffect(() => {
    if (!isPending && !session) {
      fireAndForget(router.replace(Routes.signIn));
    }
  }, [isPending, session, router]);

  const isEnabled = Boolean(session);
  const listQuery = trpc.workspace.list.useQuery(undefined, { enabled: isEnabled });
  const activeQuery = trpc.workspace.active.useQuery(undefined, { enabled: isEnabled });

  if (isPending || !session) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>
    );
  }

  const user = { name: session.user.name, email: session.user.email };
  const workspaces = (listQuery.data?.workspaces ?? []).map(ws => ({ id: ws.id, name: ws.name }));
  const activeId = activeQuery.data?.workspace?.id ?? null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-1.5">
          <Link href={Routes.workspaces} className="flex items-center" aria-label="Mocco home">
            <Image src="/favicon/favicon.svg" alt="Mocco" width={28} height={28} className="size-7" />
          </Link>
          <span aria-hidden="true" className="text-lg text-border">
            /
          </span>
          <WorkspaceSwitcher workspaces={workspaces} activeId={activeId} />
        </div>
        <UserMenu user={user} />
      </header>
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
