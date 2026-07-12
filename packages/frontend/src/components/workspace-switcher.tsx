import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { Routes } from '../lib/routes';
import { trpc } from '../lib/trpc';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

interface Props {
  workspaces: { id: string; name: string }[];
  activeId: string | null;
}

// Top-bar workspace switcher (Base UI menu handles outside-click, Escape and
// focus). Selecting a workspace makes it active server-side, then re-runs the
// page's getServerSideProps so every surface sees the new active workspace.
export default function WorkspaceSwitcher({ workspaces, activeId }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const active = workspaces.find(ws => ws.id === activeId);

  const switchTo = async (workspaceId: string) => {
    if (workspaceId === activeId) {
      return;
    }
    setBusy(true);
    try {
      await trpc.workspace.setActive.mutate({ workspaceId });
      await router.replace(router.asPath);
    } catch {
      setBusy(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium transition hover:bg-muted disabled:opacity-50 aria-expanded:bg-muted">
        <span className="max-w-40 truncate">{active?.name ?? 'No workspace'}</span>
        <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {workspaces.map(ws => (
          <DropdownMenuItem
            key={ws.id}
            onClick={async () => {
              await switchTo(ws.id);
            }}>
            <span className="flex-1 truncate">{ws.name}</span>
            {ws.id === activeId && <CheckIcon className="size-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link href={Routes.workspaces}>Manage workspaces</Link>} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
