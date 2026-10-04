import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import ProjectLayout from '@frontend/components/project-layout';
import StatusPages from '@frontend/components/status/status-pages';
import { ProjectSections } from '@frontend/lib/products';

// A project's status pages (#148): its pages, and on the one shown (`?page=`) the component
// groups and components with the status each reports and shows.
export default function ProjectStatusPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.status}>
          <StatusPages workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
