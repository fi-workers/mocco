import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import { CommitDetail } from '@frontend/components/commit-detail';
import WorkspaceLayout from '@frontend/components/workspace-layout';

// A single commit's detail — its .mocco.yml snapshot as an ordered pipeline (or
// the reason it isn't one yet). A drilldown from the candidate queue on Overview,
// so it lives under the "overview" nav tab (there's no dedicated commits tab).
export default function WorkspaceCommitPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const commitId = typeof router.query.commitId === 'string' ? router.query.commitId : null;

  return (
    <AppShell>
      {id && commitId ? (
        <WorkspaceLayout workspaceId={id} active="overview">
          <CommitDetail workspaceId={id} commitId={commitId} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
