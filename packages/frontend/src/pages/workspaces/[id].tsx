import AppShell from '@/components/app-shell';
import WorkspaceDashboard from '@/components/workspace-dashboard';

import type { ShellProps } from '@/lib/with-shell';

export { workspaceDashboardServerSideProps as getServerSideProps } from '@/lib/with-shell';

// A workspace's dashboard (its repos + deploy governance). getServerSideProps
// makes the URL's workspace active, so `activeId` is this page's workspace.
export default function WorkspaceDashboardPage({ user, workspaces, activeId }: ShellProps) {
  const workspace = workspaces.find(ws => ws.id === activeId);
  return (
    <AppShell user={user} workspaces={workspaces} activeId={activeId}>
      <WorkspaceDashboard name={workspace?.name ?? 'Workspace'} />
    </AppShell>
  );
}
