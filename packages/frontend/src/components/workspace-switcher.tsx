import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { Routes } from '../lib/routes';
import { trpc } from '../lib/trpc';

interface Props {
  workspaces: { id: string; name: string }[];
  activeId: string | null;
}

// Sidebar workspace switcher: shows the active workspace and switches on select.
// Switching re-runs the page's getServerSideProps so every surface sees the new
// active workspace (no client-side workspace store yet).
export default function WorkspaceSwitcher({ workspaces, activeId }: Props) {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = workspaces.find(ws => ws.id === activeId);

  const switchTo = async (workspaceId: string) => {
    setBusy(true);
    try {
      await trpc.workspace.setActive.mutate({ workspaceId });
      await router.replace(router.asPath);
    } catch {
      setBusy(false);
    }
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={busy}
        onClick={() => setIsOpen(previous => !previous)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium transition hover:bg-neutral-50 disabled:opacity-50">
        <span className="truncate">{active?.name ?? 'No workspace'}</span>
        <span aria-hidden="true" className="text-neutral-400">
          ⌄
        </span>
      </button>

      {isOpen && (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
          {workspaces.map(ws => (
            <button
              key={ws.id}
              type="button"
              disabled={busy}
              onClick={async () => {
                await switchTo(ws.id);
              }}
              className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm transition disabled:opacity-50 ${
                ws.id === activeId ? 'font-medium text-violet-700' : 'text-neutral-700 hover:bg-neutral-50'
              }`}>
              {ws.name}
            </button>
          ))}
          <Link
            href={Routes.workspaces}
            className="block rounded px-2 py-1.5 text-sm text-neutral-500 transition hover:bg-neutral-50">
            Manage workspaces
          </Link>
        </div>
      )}
    </div>
  );
}
