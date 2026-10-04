import Link from 'next/link';

import { StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import SideNavLayout from '@frontend/components/side-nav-layout';
import { productCatalog, projectNav, visibleEntries } from '@frontend/lib/products';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';
import { useActiveWorkspace } from '@frontend/lib/use-active-workspace';

import type { ProjectSection } from '@frontend/lib/products';
import type { Product } from '@mocco/common/project';
import type { ReactNode } from 'react';

interface Props {
  workspaceId: string;
  projectId: string;
  active: ProjectSection;
  children: ReactNode;
}

// The project frame: inside a project the sidebar becomes the project's own — the
// registry's project sections, grouped by job and filtered by enabled products — with
// a way back to the workspace. A project that isn't in this workspace shows a
// not-found state instead of content.
export default function ProjectLayout({ workspaceId, projectId, active, children }: Props) {
  const { workspace } = useActiveWorkspace(workspaceId);
  const projectQuery = trpc.project.get.useQuery({ workspaceId, projectId }, { retry: false });
  const productsQuery = trpc.product.list.useQuery({ workspaceId });
  const enabled = productsQuery.data?.products ?? [];
  const items = visibleEntries(projectNav, enabled).map(entry => ({
    key: entry.key,
    label: entry.label,
    href: entry.href(workspaceId, projectId),
    group: entry.group,
  }));
  // Offer the Products page while a product with screens is still off, so a project
  // never hides that it could do more.
  const canAddProducts =
    productsQuery.isSuccess &&
    (Object.keys(productCatalog) as Product[]).some(
      product => productCatalog[product].available && !enabled.includes(product),
    );
  const project = projectQuery.data?.project;

  return (
    <SideNavLayout
      label="Project"
      items={items}
      activeKey={active}
      header={
        <div className="flex flex-col gap-1 px-2">
          <Link
            href={Routes.workspaceProjects(workspaceId)}
            className="truncate text-xs text-muted-foreground transition hover:text-foreground">
            ← {workspace?.name ?? 'Workspace'}
          </Link>
          <span className="truncate text-sm font-medium">{project?.name ?? 'Project'}</span>
        </div>
      }
      footer={
        canAddProducts ? (
          <Link
            href={Routes.workspaceProducts(workspaceId)}
            className="hidden px-3 text-xs text-muted-foreground transition hover:text-foreground md:block">
            + Add products
          </Link>
        ) : null
      }>
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
            <p className="font-mono text-xs text-muted-foreground">{project?.handle ?? '…'}</p>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{project?.name ?? 'Project'}</h1>
              {project?.archivedAt ? <StatusBadge tone={Tones.neutral}>Archived</StatusBadge> : null}
            </div>
          </div>
          {children}
        </div>
      )}
    </SideNavLayout>
  );
}
