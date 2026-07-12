import { appRouter } from '@mocco/backend/trpc/root';

import { Routes } from './routes';
import { withAuth } from './with-auth';

import type { AuthContext } from './with-auth';
import type { GetServerSideProps } from 'next';

/** The data every AppShell page needs: the signed-in user + their workspaces. */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- must be a `type` (not interface) to satisfy the Record<string, unknown> props constraint on getServerSideProps generics
export type ShellProps = {
  user: { name: string; email: string };
  workspaces: { id: string; name: string }[];
  activeId: string | null;
};

/** Fetch the shell data (user + their workspaces + active) for an authed request. */
export async function fetchShellProps({ auth, workspace, session, headers }: AuthContext): Promise<ShellProps> {
  const caller = appRouter.createCaller({ auth, workspace, session, headers });
  const [list, active] = await Promise.all([caller.workspace.list(), caller.workspace.active()]);
  return {
    user: { name: session.user.name, email: session.user.email },
    workspaces: list.workspaces.map(ws => ({ id: ws.id, name: ws.name })),
    activeId: active.workspace?.id ?? null,
  };
}

/**
 * getServerSideProps for pages that require an active workspace (everything but
 * the workspaces page itself): auth-gated + shell data, redirecting a
 * workspace-less user to /account, where they create their first one.
 */
export const shellServerSideProps: GetServerSideProps<ShellProps> = withAuth<ShellProps>(async (_context, context) => {
  const props = await fetchShellProps(context);
  if (props.workspaces.length === 0) {
    return { redirect: { destination: Routes.workspaces, permanent: false } };
  }
  return { props };
});

/**
 * getServerSideProps for the workspace dashboard (/workspaces/[id]): makes the
 * URL's workspace active — which also validates membership, since setActive
 * rejects a workspace the user isn't in — then loads the shell data (now
 * reporting that workspace as active). An unknown or forbidden id is bounced to
 * the workspaces list.
 */
export const workspaceDashboardServerSideProps: GetServerSideProps<ShellProps> = withAuth<ShellProps>(
  async (context, authContext) => {
    const workspaceId = context.params?.id;
    if (typeof workspaceId !== 'string') {
      return { notFound: true };
    }
    try {
      await appRouter.createCaller(authContext).workspace.setActive({ workspaceId });
    } catch {
      return { redirect: { destination: Routes.workspaces, permanent: false } };
    }
    return { props: await fetchShellProps(authContext) };
  },
);
