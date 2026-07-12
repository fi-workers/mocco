import { useRouter } from 'next/router';
import { useEffect } from 'react';

import WorkspaceForm from '@/components/workspace-form';
import { useSession } from '@/lib/auth-client';
import { fireAndForget } from '@/lib/fire-and-forget';
import { Routes } from '@/lib/routes';
import { trpc } from '@/lib/trpc';

// /workspaces is a router, not a list: with a workspace it jumps straight into
// one's dashboard (the active one, else the first). With none — or ?create — it
// shows the focused create view. Fully client-rendered.
export default function WorkspacesPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const isForceCreate = 'create' in router.query;

  useEffect(() => {
    if (!isPending && !session) {
      fireAndForget(router.replace(Routes.signIn));
    }
  }, [isPending, session, router]);

  const isEnabled = Boolean(session);
  const listQuery = trpc.workspace.list.useQuery(undefined, { enabled: isEnabled });
  const activeQuery = trpc.workspace.active.useQuery(undefined, { enabled: isEnabled });
  const { mutateAsync: createWorkspace } = trpc.workspace.create.useMutation();

  const workspaces = listQuery.data?.workspaces ?? [];
  const activeId = activeQuery.data?.workspace?.id ?? null;
  const firstId = workspaces[0]?.id ?? null;
  const hasWorkspace = workspaces.length > 0;
  const isReady = isEnabled && router.isReady && listQuery.isSuccess && activeQuery.isSuccess;

  useEffect(() => {
    if (!(isReady && !isForceCreate && hasWorkspace)) {
      return;
    }

    const target = activeId ?? firstId;
    if (target) {
      fireAndForget(router.replace(Routes.workspace(target)));
    }
  }, [isReady, isForceCreate, hasWorkspace, activeId, firstId, router]);

  // Loading, or about to jump into a workspace.
  if (!isReady || (!isForceCreate && hasWorkspace)) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />
      </div>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">
          {hasWorkspace ? 'Create a workspace' : 'Create your first workspace'}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A workspace is your team boundary — repos, members and deploy governance live inside it.
        </p>
      </div>
      <WorkspaceForm
        onSubmit={async values => {
          const { workspace } = await createWorkspace(values);
          await router.push(Routes.workspace(workspace.id));
        }}
      />
    </main>
  );
}
