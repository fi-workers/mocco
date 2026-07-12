import { appRouter } from '@mocco/backend/trpc/root';

import AppShell from '../components/app-shell';
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
    <AppShell user={user}>
      <Workspaces initialWorkspaces={workspaces} initialActiveId={activeId} />
    </AppShell>
  );
}
