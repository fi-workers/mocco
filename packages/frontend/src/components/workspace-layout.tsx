import { Products } from '@mocco/common/project';

import SideNavLayout from '@frontend/components/side-nav-layout';
import { visibleEntries, workspaceNav } from '@frontend/lib/products';
import { trpc } from '@frontend/lib/trpc';
import { useActiveWorkspace } from '@frontend/lib/use-active-workspace';

import type { WorkspaceSection } from '@frontend/lib/products';
import type { ReactNode } from 'react';

interface Props {
  workspaceId: string;
  active: WorkspaceSection;
  children: ReactNode;
}

// The workspace-scoped frame: a sidebar of the product registry's workspace sections,
// grouped by job and filtered by the workspace's enabled products, beside the section
// content, shown inside the global AppShell. Project pages swap this sidebar for the
// project's own (ProjectLayout), the way a project is entered in the top bar.
export default function WorkspaceLayout({ workspaceId, active, children }: Props) {
  const { workspace } = useActiveWorkspace(workspaceId);
  // Until the enabled products load, governance (always on) is the safe assumption.
  const productsQuery = trpc.product.list.useQuery({ workspaceId });
  const items = visibleEntries(workspaceNav, productsQuery.data?.products ?? [Products.governance]).map(entry => ({
    key: entry.key,
    label: entry.label,
    href: entry.href(workspaceId),
    group: entry.group,
  }));

  return (
    <SideNavLayout
      label="Workspace"
      items={items}
      activeKey={active}
      header={
        <div className="flex items-center gap-2 px-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
            {(workspace?.name ?? '?').charAt(0).toUpperCase()}
          </div>
          <span className="truncate text-sm font-medium">{workspace?.name ?? 'Workspace'}</span>
        </div>
      }>
      {children}
    </SideNavLayout>
  );
}
