import { appRouter } from '@mocco/backend/trpc/root';
import Link from 'next/link';

import Workspaces from '../components/workspaces';
import { withAuth } from '../lib/with-auth';

import type { InferGetServerSidePropsType } from 'next';

// Auth-guarded (withAuth): authenticated requests arrive with their workspaces
// already loaded; unauthenticated ones are redirected before this runs.
export const getServerSideProps = withAuth(async (_context, { auth, workspace, session, headers }) => {
  const caller = appRouter.createCaller({ auth, workspace, session, headers });
  const [list, active] = await Promise.all([caller.workspace.list(), caller.workspace.active()]);
  return {
    props: {
      user: { name: session.user.name, email: session.user.email },
      workspaces: list.workspaces.map(ws => ({ id: ws.id, name: ws.name })),
      activeId: active.workspace?.id ?? null,
    },
  };
});

export default function AccountPage({
  user,
  workspaces,
  activeId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 px-6">
      <h1 className="text-xl font-bold tracking-tight">Account</h1>

      <div className="flex items-center gap-4 rounded-xl border border-neutral-200 p-5">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-600 font-semibold text-white">
          {user.name.charAt(0).toUpperCase()}
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium">{user.name}</div>
          <div className="truncate text-sm text-neutral-500">{user.email}</div>
        </div>
      </div>

      <Workspaces initialWorkspaces={workspaces} initialActiveId={activeId} />

      <Link
        href="/auth/sign-out"
        className="inline-flex h-11 items-center justify-center rounded-lg border border-neutral-200 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50">
        Sign out
      </Link>
    </main>
  );
}
