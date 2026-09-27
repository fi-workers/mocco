import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import ForceUpdatePage from '@frontend/components/ota/force-update-page';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's OTA screen: force update for its store apps. The ids are the path; the
// selected app is `?app=` (read by the page component).
export default function ProjectOtaPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.ota}>
          <ForceUpdatePage workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
