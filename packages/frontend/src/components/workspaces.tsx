import { useState } from 'react';

import { trpc } from '../lib/trpc';

import Button from './button';
import WorkspaceForm from './workspace-form';
import { useWorkspaces } from './workspace-provider';

// The workspaces list page's manager: list, switch active, and add another. State
// comes from the WorkspaceProvider, so the sidebar switcher stays in sync. Only
// rendered when at least one workspace exists (the empty first-run is a focused
// create view on the page itself).
export default function Workspaces() {
  const { workspaces, activeId, setActive, refresh } = useWorkspaces();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which workspace's Switch is mid-activation — so only that row spins.
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const handleActivate = async (workspaceId: string) => {
    setActivatingId(workspaceId);
    setError(null);
    try {
      await setActive(workspaceId);
    } catch (activateError) {
      setError((activateError as Error).message);
    }
    setActivatingId(null);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-700">Workspaces</h2>
        {!creating && (
          <Button variant="ghost" onClick={() => setCreating(true)} className="text-sm">
            + New workspace
          </Button>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {workspaces.map(ws => {
          const isActive = ws.id === activeId;
          return (
            <li key={ws.id} className="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-sm font-semibold text-white">
                {ws.name.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{ws.name}</div>
              </div>
              {isActive ? (
                <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-medium text-violet-700">
                  Active
                </span>
              ) : (
                <Button
                  variant="secondary"
                  disabled={activatingId !== null}
                  pending={activatingId === ws.id}
                  onClick={async () => {
                    await handleActivate(ws.id);
                  }}
                  className="px-3 py-1.5 text-xs">
                  Switch
                </Button>
              )}
            </li>
          );
        })}
      </ul>

      {creating && (
        <WorkspaceForm
          onSubmit={async values => {
            await trpc.workspace.create.mutate(values);
            setCreating(false);
            await refresh();
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      {error && !creating && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
