import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import FeedbackChangelogEntry from '@frontend/components/feedback-console/changelog-entry';
import ProjectLayout from '@frontend/components/project-layout';
import { ProjectSections } from '@frontend/lib/products';

// One changelog entry's editor (#176): its text and posts, then publishing or scheduling it.
export default function ProjectFeedbackChangelogEntryPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const projectId = typeof router.query.projectId === 'string' ? router.query.projectId : null;
  const entryId = typeof router.query.entryId === 'string' ? router.query.entryId : null;

  return (
    <AppShell>
      {id && projectId && entryId ? (
        <ProjectLayout workspaceId={id} projectId={projectId} active={ProjectSections.feedback}>
          <FeedbackChangelogEntry key={entryId} workspaceId={id} projectId={projectId} entryId={entryId} />
        </ProjectLayout>
      ) : null}
    </AppShell>
  );
}
