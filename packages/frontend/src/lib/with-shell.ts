import { appRouter } from '@mocco/backend/trpc/root';

import { Routes } from './routes';
import { withAuth } from './with-auth';

import type { GetServerSideProps } from 'next';

/** The data every AppShell page needs: the signed-in user + their workspaces. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- must be a `type` (not interface) to satisfy the Record<string, unknown> props constraint on getServerSideProps generics
export type ShellProps = {
  user: { name: string; email: string };
  workspaces: { id: string; name: string }[];
  activeId: string | null;
};

/**
 * Ready-made getServerSideProps for pages that render inside AppShell: auth-gated
 * (withAuth) plus the shell data (user + workspaces + active) the sidebar needs.
 * A page with no extra data just re-exports this as its getServerSideProps.
 */
export const shellServerSideProps: GetServerSideProps<ShellProps> = withAuth<ShellProps>(async (_context, context) => {
  const { auth, workspace, session, headers } = context;
  const caller = appRouter.createCaller({ auth, workspace, session, headers });
  const [list, active] = await Promise.all([caller.workspace.list(), caller.workspace.active()]);
  // A user with no workspace can't use the shell — send them to onboarding first.
  if (list.workspaces.length === 0) {
    return { redirect: { destination: Routes.onboarding, permanent: false } };
  }
  return {
    props: {
      user: { name: session.user.name, email: session.user.email },
      workspaces: list.workspaces.map(ws => ({ id: ws.id, name: ws.name })),
      activeId: active.workspace?.id ?? null,
    },
  };
});
