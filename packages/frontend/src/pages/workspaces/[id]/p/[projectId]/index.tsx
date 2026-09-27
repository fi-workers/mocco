import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import ProjectLayout from '@frontend/components/project-layout';
import ProjectOverview from '@frontend/components/project-overview';
import { ProjectSections } from '@frontend/lib/products';

// A project's home (apps, repos, archive). The workspace and project ids are the path.
export default function ProjectPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.overview}>
          <ProjectOverview workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
