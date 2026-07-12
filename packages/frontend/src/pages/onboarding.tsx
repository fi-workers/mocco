import { appRouter } from '@mocco/backend/trpc/root';
import { useRouter } from 'next/router';

import WorkspaceCreateForm from '../components/workspace-create-form';
import { Routes } from '../lib/routes';
import { withAuth } from '../lib/with-auth';

// A fresh user (no workspace) is sent here by the shell guard. Once they have a
// workspace, this redirects into the app. A focused page — no sidebar yet.
export const getServerSideProps = withAuth(async (_context, { auth, workspace, session, headers }) => {
  const caller = appRouter.createCaller({ auth, workspace, session, headers });
  const { workspaces } = await caller.workspace.list();
  if (workspaces.length > 0) {
    return { redirect: { destination: Routes.account, permanent: false } };
  }
  return { props: {} };
});

export default function OnboardingPage() {
  const router = useRouter();

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Create your first workspace</h1>
        <p className="mt-2 text-sm text-neutral-500">
          A workspace is your team boundary — repos, members and deploy governance live inside it.
        </p>
      </div>
      <WorkspaceCreateForm
        onCreated={async () => {
          await router.push(Routes.account);
        }}
      />
    </main>
  );
}
