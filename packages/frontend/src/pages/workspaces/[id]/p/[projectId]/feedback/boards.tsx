import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import FeedbackBoards from '@frontend/components/feedback-console/boards';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's feedback boards (#175): create, rename, publish or delete them, and their categories.
export default function ProjectFeedbackBoardsPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.feedback}>
          <FeedbackBoards workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
