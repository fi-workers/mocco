import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import FeedbackDuplicates from '@frontend/components/feedback-console/duplicates';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A board's suggested duplicate pairs in the console (#181): merge each or set it aside.
export default function ProjectFeedbackDuplicatesPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.feedback}>
          <FeedbackDuplicates workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
