// Every component on a project's status pages (#150): monitors report on components of any of
// the project's pages, so their screens read each page's components.
import { trpc } from '@frontend/lib/trpc';

import type { StatusOutputs } from '@frontend/components/status/status-ui';

type Page = StatusOutputs['pages']['pages'][number];
type Component = StatusOutputs['page']['components'][number];

export interface PageWithComponents {
  page: Page;
  components: Component[];
}

/** The project's pages with their components, in page order, and each component's name by id. */
export function useProjectComponents(workspaceId: string, projectId: string) {
  const pagesQuery = trpc.status.pages.useQuery({ workspaceId, projectId });
  const pages = pagesQuery.data?.pages ?? [];
  const pageQueries = trpc.useQueries(t =>
    pages.map(page => t.status.page({ workspaceId, projectId, pageId: page.id })),
  );
  const byPage: PageWithComponents[] = pages.map((page, index) => ({
    page,
    components: pageQueries[index]?.data?.components ?? [],
  }));
  const names = new Map(byPage.flatMap(entry => entry.components.map(component => [component.id, component.name])));
  return {
    pages: byPage,
    names,
    isPending: pagesQuery.isPending || pageQueries.some(query => query.isPending),
  };
}
