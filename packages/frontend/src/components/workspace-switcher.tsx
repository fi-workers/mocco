import Link from 'next/link';
import { useState } from 'react';

import { Routes } from '../lib/routes';

import { useWorkspaces } from './workspace-provider';

// Sidebar workspace switcher. State comes from the WorkspaceProvider, so
// switching is optimistic (no page reload) and the workspaces list stays in sync.
export default function WorkspaceSwitcher() {
  const { workspaces, activeId, setActive } = useWorkspaces();
  const [isOpen, setIsOpen] = useState(false);
  const active = workspaces.find(ws => ws.id === activeId);

  const switchTo = async (workspaceId: string) => {
    setIsOpen(false);
    await setActive(workspaceId);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(previous => !previous)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium transition hover:bg-neutral-50">
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
              onClick={async () => {
                await switchTo(ws.id);
              }}
              className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm transition ${
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
