import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import Inbox from '@frontend/components/messenger/inbox';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's messenger inbox (#95): setup, the open or closed conversations (`?status=`),
// and settings.
export default function ProjectInboxPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.inbox}>
          <Inbox workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
