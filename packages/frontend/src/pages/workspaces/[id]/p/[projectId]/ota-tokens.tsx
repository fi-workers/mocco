import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import PublishingTokens from '@frontend/components/ota/publishing-tokens';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's OTA tokens: the publishing tokens of its existing OTA tool, released
// only through the credential broker. The workspace and project ids are the path.
export default function ProjectOtaTokensPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.otaTokens}>
          <PublishingTokens workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
