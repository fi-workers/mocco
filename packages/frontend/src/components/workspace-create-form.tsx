import { useState } from 'react';

import { trpc } from '../lib/trpc';

import Button from './button';

interface Props {
  /** Called after a workspace is created (refresh, navigate, …). */
  onCreated: () => void | Promise<void>;
  /** Optional cancel button (omitted during onboarding). */
  onCancel?: () => void;
}

// Shared create-a-workspace form — used both for onboarding (first workspace)
// and for adding another from the account page.
export default function WorkspaceCreateForm({ onCreated, onCancel }: Props) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    // No try/finally: React Compiler can't optimize components containing `finally`.
    try {
      await trpc.workspace.create.mutate({ name });
      setName('');
      await onCreated();
    } catch (createError) {
      setError((createError as Error).message);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
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
        {onCancel && (
          <Button variant="secondary" disabled={busy} onClick={onCancel} className="h-10 px-4 text-sm">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
