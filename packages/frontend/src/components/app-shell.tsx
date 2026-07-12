import Link from 'next/link';

import { Routes } from '@/lib/routes';

import UserMenu from './user-menu';
import WorkspaceSwitcher from './workspace-switcher';

import type { ShellProps } from '@/lib/with-shell';
import type { ReactNode } from 'react';

type Props = ShellProps & { children: ReactNode };

// The authenticated app layout, Vercel-style: a slim top bar (logo + workspace
// switcher on the left, the signed-in user on the right) above the page content.
export default function AppShell({ user, workspaces, activeId, children }: Props) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-1.5">
          <Link
            href={Routes.workspaces}
            className="flex size-7 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
            M
          </Link>
          <span aria-hidden="true" className="text-lg text-border">
            /
          </span>
          <WorkspaceSwitcher workspaces={workspaces} activeId={activeId} />
        </div>
        <UserMenu user={user} />
      </header>
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
