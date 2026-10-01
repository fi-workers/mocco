import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import FeatureFlags from '@frontend/components/flags/feature-flags';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's feature flags (#137): environments, flags and each environment's change
// history. The ids are the path; the environment whose history is shown is `?env=`.
export default function ProjectFlagsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.flags}>
          <FeatureFlags workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
