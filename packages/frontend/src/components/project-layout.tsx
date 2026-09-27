import Link from 'next/link';

import { StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import WorkspaceLayout from '@frontend/components/workspace-layout';
import { projectNav, visibleEntries, WorkspaceSections } from '@frontend/lib/products';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { cn } from '@frontend/lib/utils';

import type { ProjectSection } from '@frontend/lib/products';
import type { ReactNode } from 'react';

interface Props {
  workspaceId: string;
  projectId: string;
  active: ProjectSection;
  children: ReactNode;
}

// The project frame: the workspace frame (Projects selected), a project header and
// the project's tabs — the registry's project sections, filtered by enabled products.
// A project that isn't in this workspace shows a not-found state instead of content.
export default function ProjectLayout({ workspaceId, projectId, active, children }: Props) {
  const projectQuery = trpc.project.get.useQuery({ workspaceId, projectId }, { retry: false });
  const productsQuery = trpc.product.list.useQuery({ workspaceId });
  const tabs = visibleEntries(projectNav, productsQuery.data?.products ?? []);
  const project = projectQuery.data?.project;

  return (
    <WorkspaceLayout workspaceId={workspaceId} active={WorkspaceSections.projects}>
      {projectQuery.isError ? (
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Project not found</h1>
          <p className="text-sm text-muted-foreground">
            It doesn’t exist or isn’t in this workspace.{' '}
            <Link href={Routes.workspaceProjects(workspaceId)} className="underline underline-offset-2">
              All projects
            </Link>
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted-foreground">
              <Link href={Routes.workspaceProjects(workspaceId)} className="hover:text-foreground">
                Projects
              </Link>{' '}
              / <span className="font-mono">{project?.handle ?? '…'}</span>
            </p>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{project?.name ?? 'Project'}</h1>
              {project?.archivedAt ? <StatusBadge tone={Tones.neutral}>Archived</StatusBadge> : null}
            </div>
          </div>
          <nav aria-label="Project" className="flex gap-1 border-b border-border">
            {tabs.map(tab => (
              <Link
                key={tab.key}
                href={tab.href(workspaceId, projectId)}
                aria-current={tab.key === active ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition',
                  tab.key === active
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}>
                {tab.label}
              </Link>
            ))}
          </nav>
          {children}
        </div>
      )}
    </WorkspaceLayout>
  );
}
