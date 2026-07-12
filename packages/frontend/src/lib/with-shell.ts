import { appRouter } from '@mocco/backend/trpc/root';

import { withAuth } from './with-auth';

import type { GetServerSideProps } from 'next';

/** The data every AppShell page needs: the signed-in user + their workspaces. */
export interface ShellProps {
  user: { name: string; email: string };
  workspaces: { id: string; name: string }[];
  activeId: string | null;
}

/**
 * Ready-made getServerSideProps for pages that render inside AppShell: auth-gated
 * (withAuth) plus the shell data (user + workspaces + active) the sidebar needs.
 * A page with no extra data just re-exports this as its getServerSideProps.
 */
export const shellServerSideProps: GetServerSideProps<ShellProps> = withAuth(async (_context, context) => {
  const { auth, workspace, session, headers } = context;
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
