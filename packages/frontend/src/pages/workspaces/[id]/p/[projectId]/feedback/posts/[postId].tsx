import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import FeedbackPost from '@frontend/components/feedback-console/post';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A feedback post in the console (#175): status, category, comments, votes, history and merging.
export default function ProjectFeedbackPostPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const postId = typeof router.query.postId === 'string' ? router.query.postId : null;

  return (
    <AppShell>
      {id && projectId && postId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.feedback}>
          <FeedbackPost key={postId} workspaceId={id} projectId={projectId} postId={postId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
