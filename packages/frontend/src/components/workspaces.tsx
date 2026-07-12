import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { Routes } from '@/lib/routes';
import { trpc } from '@/lib/trpc';

import Button from './button';
import WorkspaceForm from './workspace-form';

import type { WorkspaceCreateInput } from '@mocco/common/workspace';

interface Props {
  initialWorkspaces: { id: string; name: string }[];
  initialActiveId: string | null;
}

// The workspaces list: open one (→ its dashboard) or add another. Only rendered
// when at least one workspace exists — the page shows its own focused create
// view for the empty (first-run) case.
export default function Workspaces({ initialWorkspaces, initialActiveId }: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  const addWorkspace = async (values: WorkspaceCreateInput) => {
    const { workspace } = await trpc.workspace.create.mutate(values);
    await router.push(Routes.workspace(workspace.id));
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Workspaces</h2>
        {!creating && (
          <Button variant="ghost" onClick={() => setCreating(true)} className="text-sm">
            + New workspace
          </Button>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {initialWorkspaces.map(ws => (
          <li key={ws.id}>
            <Link
              href={Routes.workspace(ws.id)}
              className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 transition hover:bg-muted">
              <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                {ws.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{ws.name}</div>
              </div>
              {ws.id === initialActiveId && (
                <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  Active
                </span>
              )}
              <ChevronRightIcon className="size-4 text-muted-foreground" />
            </Link>
          </li>
        ))}
      </ul>

      {creating && <WorkspaceForm onSubmit={addWorkspace} onCancel={() => setCreating(false)} />}
    </section>
  );
}
