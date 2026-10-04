import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import OtaHosting from '@frontend/components/ota/ota-hosting';
import OtaTabBar, { OtaTabs } from '@frontend/components/ota/ota-tabs';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's OTA updates, "Hosted by Mocco" tab (ADR 0021): the OTA app, its signing certificates
// and channels. The ids are the path; the selected OTA app is `?app=`.
export default function ProjectOtaHostingPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.otaUpdates}>
          <div className="flex flex-col gap-6">
            <OtaTabBar workspaceId={id} projectId={projectId} active={OtaTabs.hosted} />
            <OtaHosting workspaceId={id} projectId={projectId} />
          </div>
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
