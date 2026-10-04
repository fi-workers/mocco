import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import OtaTabBar, { OtaTabs } from '@frontend/components/ota/ota-tabs';
import PublishingTokens from '@frontend/components/ota/publishing-tokens';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's OTA updates, "Your OTA tool" tab: the publishing tokens of its existing
// OTA tool, released only through the credential broker. The workspace and project ids are the path.
export default function ProjectOtaTokensPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.otaUpdates}>
          <div className="flex flex-col gap-6">
            <OtaTabBar workspaceId={id} projectId={projectId} active={OtaTabs.ownTool} />
            <PublishingTokens workspaceId={id} projectId={projectId} />
          </div>
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
