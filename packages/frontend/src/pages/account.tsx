import { useRouter } from 'next/router';

import AppShell from '../components/app-shell';
import WorkspaceForm from '../components/workspace-form';
import Workspaces from '../components/workspaces';
import { trpc } from '../lib/trpc';
import { withAuth } from '../lib/with-auth';
import { fetchShellProps } from '../lib/with-shell';

import type { ShellProps } from '../lib/with-shell';

// The workspaces page. Unlike other shell pages it does NOT redirect a
// workspace-less user (it's where they land to create their first) — so it
// fetches the shell data without the redirect guard.
export const getServerSideProps = withAuth<ShellProps>(async (_context, context) => ({
  props: await fetchShellProps(context),
}));

export default function AccountPage({ user, workspaces, activeId }: ShellProps) {
  const router = useRouter();

  // First run: no workspace yet — a focused create view, no sidebar.
  if (workspaces.length === 0) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Create your first workspace</h1>
          <p className="mt-2 text-sm text-neutral-500">
            A workspace is your team boundary — repos, members and deploy governance live inside it.
          </p>
        </div>
        <WorkspaceForm
          onSubmit={async values => {
            await trpc.workspace.create.mutate(values);
            await router.replace(router.asPath);
          }}
        />
      </main>
    );
  }

  return (
    <AppShell user={user} workspaces={workspaces} activeId={activeId}>
      <Workspaces initialWorkspaces={workspaces} initialActiveId={activeId} />
    </AppShell>
  );
}
