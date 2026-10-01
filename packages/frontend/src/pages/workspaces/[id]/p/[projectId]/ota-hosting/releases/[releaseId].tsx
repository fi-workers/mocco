import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import OtaReleasePage from '@frontend/components/ota/ota-release-page';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A hosted OTA release page; the OTA app is `?app=`.
export default function ProjectOtaReleasePage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const releaseId = typeof router.query.releaseId === 'string' ? router.query.releaseId : null;

  return (
    <AppShell>
      {id && projectId && releaseId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.otaHosting}>
          <OtaReleasePage workspaceId={id} projectId={projectId} releaseId={releaseId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
