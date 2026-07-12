import { useState } from 'react';

import { trpc } from '../lib/trpc';

import Button from './button';

interface WorkspaceItem {
  id: string;
  name: string;
}

interface Props {
  initialWorkspaces: WorkspaceItem[];
  initialActiveId: string | null;
}

export default function Workspaces({ initialWorkspaces, initialActiveId }: Props) {
  // Initial data comes from the server (getServerSideProps) — no load effect.
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [activeId, setActiveId] = useState(initialActiveId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Which workspace's Switch is mid-activation — so only that row spins, not all.
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const refresh = async () => {
    // Envelopes are the wire contract (#15): list → { workspaces }, active → { workspace }.
    const [list, active] = await Promise.all([trpc.workspace.list.query(), trpc.workspace.active.query()]);
    setWorkspaces(list.workspaces.map(ws => ({ id: ws.id, name: ws.name })));
    setActiveId(active.workspace?.id ?? null);
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // No try/finally: React Compiler can't optimize components containing `finally` clauses.
    try {
      await trpc.workspace.create.mutate({ name });
      setName('');
      setCreating(false);
      await refresh();
    } catch (createError) {
      setError((createError as Error).message);
    }
    setBusy(false);
  };

  const handleActivate = async (workspaceId: string) => {
    setBusy(true);
    setActivatingId(workspaceId);
    setError(null);
    try {
      await trpc.workspace.setActive.mutate({ workspaceId });
      await refresh();
    } catch (activateError) {
      setError((activateError as Error).message);
    }
    setBusy(false);
    setActivatingId(null);
  };

  const creationForm = (
    <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
      <input
        type="text"
        required
        maxLength={80}
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Workspace name"
        aria-label="Workspace name"
        className="h-10 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" pending={busy} className="h-10 flex-1 text-sm">
          {busy ? 'Creating…' : 'Create workspace'}
        </Button>
        {workspaces.length > 0 && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              setCreating(false);
              setError(null);
            }}
            className="h-10 px-4 text-sm">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );

  // Zero-workspace onboarding — the contract: sign-up creates no workspace.
  if (workspaces.length === 0) {
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-neutral-700">Create your first workspace</h2>
        <p className="text-sm text-neutral-500">
          A workspace is your team boundary — repos, members and deploy governance live inside it.
        </p>
        {creationForm}
      </section>
    );
  }

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
                  disabled={busy}
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

      {creating && creationForm}
      {error && !creating && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}
