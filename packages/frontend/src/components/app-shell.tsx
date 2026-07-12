import Link from 'next/link';
import { useRouter } from 'next/router';

import type { ReactNode } from 'react';

interface Props {
  user: { name: string; email: string };
  children: ReactNode;
}

const NAV = [
  { href: '/account', label: 'Workspaces' },
  { href: '/pipelines/new', label: 'Preview' },
];

// The authenticated app layout: a persistent left sidebar (nav + the signed-in
// user) around the page content. Gated pages render their body inside it.
export default function AppShell({ user, children }: Props) {
  const router = useRouter();

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 flex-col border-r border-neutral-200 px-4 py-5">
        <Link href="/account" className="mb-6 flex items-center gap-2 px-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 text-sm font-bold text-white">
            M
          </span>
          <span className="font-semibold tracking-tight">Mocco</span>
        </Link>

        <nav className="flex flex-col gap-1">
          {NAV.map(item => {
            const isActive = router.pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                  isActive ? 'bg-violet-50 text-violet-700' : 'text-neutral-600 hover:bg-neutral-50'
                }`}>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-neutral-200 pt-4">
          <div className="px-2">
            <div className="truncate text-sm font-medium">{user.name}</div>
            <div className="truncate text-xs text-neutral-500">{user.email}</div>
          </div>
          <Link
            href="/auth/sign-out"
            className="mt-2 block rounded-lg px-3 py-2 text-sm text-neutral-600 transition hover:bg-neutral-50">
            Sign out
          </Link>
        </div>
      </aside>

      <main className="flex-1 px-8 py-10">
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
    </div>
  );
}
