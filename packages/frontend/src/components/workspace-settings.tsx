import { useRouter } from 'next/router';
import { useState } from 'react';

import { Button } from '@frontend/components/ui/button';
import WorkspaceForm from '@frontend/components/workspace-form';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { WorkspaceCreateInput } from '@mocco/common/workspace';

interface Props {
  workspaceId: string;
}

// Workspace settings: rename (shares the WorkspaceForm) and a guarded delete.
export default function WorkspaceSettings({ workspaceId }: Props) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const listQuery = trpc.workspace.list.useQuery();
  const workspace = listQuery.data?.workspaces.find(ws => ws.id === workspaceId);

  const { mutateAsync: renameWorkspace } = trpc.workspace.update.useMutation();
  const { mutateAsync: deleteWorkspace, isPending: isDeleting } = trpc.workspace.delete.useMutation();
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const rename = async (values: WorkspaceCreateInput) => {
    await renameWorkspace({ workspaceId, name: values.name });
    await Promise.all([utils.workspace.list.invalidate(), utils.workspace.active.invalidate()]);
  };

  const remove = async () => {
    await deleteWorkspace({ workspaceId });
    await utils.workspace.list.invalidate();
    await router.push(Routes.workspaces);
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Rename this workspace or delete it.</p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Name</h2>
        {workspace ? (
          <WorkspaceForm
            key={workspace.name}
            defaultValues={{ name: workspace.name }}
            submitLabel="Rename"
            onSubmit={rename}
          />
        ) : null}
      </section>

      <section className="flex flex-col gap-3 rounded-xl border border-destructive/40 p-4">
        <div>
          <h2 className="text-sm font-medium text-destructive">Delete workspace</h2>
          <p className="text-sm text-muted-foreground">This permanently removes the workspace and its data.</p>
        </div>
        {isConfirmingDelete ? (
          <div className="flex items-center gap-2">
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={async () => {
                await remove();
              }}
              className="text-sm">
              {isDeleting ? 'Deleting…' : 'Yes, delete'}
            </Button>
            <Button
              variant="outline"
              disabled={isDeleting}
              onClick={() => setIsConfirmingDelete(false)}
              className="text-sm">
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            onClick={() => setIsConfirmingDelete(true)}
            className="w-fit text-sm text-destructive">
            Delete workspace
          </Button>
        )}
      </section>
    </div>
  );
}
