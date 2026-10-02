import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import Conversation from '@frontend/components/messenger/conversation';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// One messenger conversation (#95): the thread, the composer and the user panel.
export default function ProjectConversationPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const conversationId = typeof router.query.conversationId === 'string' ? router.query.conversationId : null;

  return (
    <AppShell>
      {id && projectId && conversationId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.inbox}>
          <Conversation workspaceId={id} projectId={projectId} conversationId={conversationId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
