import AppShell from '../components/app-shell';
import Workspaces from '../components/workspaces';

import type { ShellProps } from '../lib/with-shell';

// Auth-gated + shell data (user + workspaces) — the account page needs exactly
// the shell props, so it re-exports the shared getServerSideProps directly.
export { shellServerSideProps as getServerSideProps } from '../lib/with-shell';

export default function AccountPage({ user, workspaces, activeId }: ShellProps) {
  return (
    <AppShell user={user} workspaces={workspaces} activeId={activeId}>
      <Workspaces initialWorkspaces={workspaces} initialActiveId={activeId} />
    </AppShell>
  );
}
