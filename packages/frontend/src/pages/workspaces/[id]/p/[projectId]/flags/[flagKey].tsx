import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import FlagDetail from '@frontend/components/flags/flag-detail';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// One feature flag's targeting (#140): per environment, its rules, fallthrough and a
// preview. The ids are the path; the environment is `?env=`.
export default function ProjectFlagPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const flagKey = typeof router.query.flagKey === 'string' ? router.query.flagKey : null;

  return (
    <AppShell>
      {id && projectId && flagKey ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.flags}>
          <FlagDetail workspaceId={id} projectId={projectId} flagKey={flagKey} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
