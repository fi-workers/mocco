import { CheckIcon, ChevronsUpDownIcon, LayoutGridIcon } from 'lucide-react';
import Link from 'next/link';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@frontend/components/ui/dropdown-menu';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

interface Props {
  workspaceId: string;
  /** The project in the URL, if any. */
  projectId: string | null;
}

// Top-bar project switcher, next to the workspace switcher. The active project is the
// `[projectId]` in the path (URL is state), so the label follows the URL and each item
// is a plain link to that project's home.
export default function ProjectSwitcher({ workspaceId, projectId }: Props) {
  const listQuery = trpc.project.list.useQuery({ workspaceId });
  const projects = listQuery.data?.projects ?? [];
  const active = projects.find(project => project.id === projectId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium transition hover:bg-muted aria-expanded:bg-muted">
        <span className="max-w-40 truncate">{active?.name ?? 'All projects'}</span>
        <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {projects.map(project => (
          <DropdownMenuItem
            key={project.id}
            nativeButton={false}
            render={
              <Link href={Routes.project(workspaceId, project.id)}>
                <span className="flex-1 truncate">{project.name}</span>
                {project.id === projectId && <CheckIcon className="size-4" />}
              </Link>
            }
          />
        ))}
        {projects.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          nativeButton={false}
          render={
            <Link href={Routes.workspaceProjects(workspaceId)}>
              <LayoutGridIcon className="size-4" />
              All projects
            </Link>
          }
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
