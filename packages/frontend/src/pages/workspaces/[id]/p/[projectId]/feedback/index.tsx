import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import FeedbackInbox from '@frontend/components/feedback-console/inbox';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// A project's feedback inbox (#175): one board's posts to triage, filtered in the address.
export default function ProjectFeedbackPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;

  return (
    <AppShell>
      {id && projectId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.feedback}>
          <FeedbackInbox workspaceId={id} projectId={projectId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
