import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import OtaChannelPage from '@frontend/components/ota/ota-channel-page';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A hosted OTA channel page; the OTA app is `?app=`.
export default function ProjectOtaChannelPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const channelId = typeof router.query.channelId === 'string' ? router.query.channelId : null;

  return (
    <AppShell>
      {id && projectId && channelId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.otaUpdates}>
          <OtaChannelPage workspaceId={id} projectId={projectId} channelId={channelId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
