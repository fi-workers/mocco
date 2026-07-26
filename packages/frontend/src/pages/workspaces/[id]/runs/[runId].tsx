import { useRouter } from 'next/router';

import AppShell from '@frontend/components/app-shell';
import { RunDetail } from '@frontend/components/run-detail';
import WorkspaceLayout from '@frontend/components/workspace-layout';

// A single run's detail — its state and materialized steps. Reached from the Run
// button on a commit-detail page, so it lives under the "overview" nav tab (there
// is no dedicated runs tab). Live step-by-step progression lands in PR3.
export default function WorkspaceRunPage() {
  const router = useRouter();
  const id = typeof router.query.id === 'string' ? router.query.id : null;
  const runId = typeof router.query.runId === 'string' ? router.query.runId : null;

  return (
    <AppShell>
      {id && runId ? (
        <WorkspaceLayout workspaceId={id} active="overview">
          <RunDetail workspaceId={id} runId={runId} />
        </WorkspaceLayout>
      ) : null}
    </AppShell>
  );
}
