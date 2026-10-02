import { useRouter } from 'next/router';

import ApiKeys from '@frontend/components/api-keys';
import AppShell from '@frontend/components/app-shell';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's API keys for the public /v1 API (ADR 0017): publishable keys for apps,
// secret keys for servers. The workspace and project ids are the path.
export default function ProjectApiKeysPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.apiKeys}>
          <ApiKeys workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
