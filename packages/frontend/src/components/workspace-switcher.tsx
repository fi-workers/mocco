import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import Link from 'next/link';

import { Routes } from '@/lib/routes';

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
// focus). Each item links to that workspace's dashboard; visiting it makes it
// active server-side, so the switcher label follows the current URL.
export default function WorkspaceSwitcher({ workspaces, activeId }: Props) {
  const active = workspaces.find(ws => ws.id === activeId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium transition hover:bg-muted aria-expanded:bg-muted">
        <span className="max-w-40 truncate">{active?.name ?? 'No workspace'}</span>
        <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {workspaces.map(ws => (
          <DropdownMenuItem
            key={ws.id}
            nativeButton={false}
            render={
              <Link href={Routes.workspace(ws.id)}>
                <span className="flex-1 truncate">{ws.name}</span>
                {ws.id === activeId && <CheckIcon className="size-4" />}
              </Link>
            }
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem nativeButton={false} render={<Link href={Routes.workspaces}>Manage workspaces</Link>} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
