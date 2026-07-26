import { useRouter } from 'next/router';

import { PipelineSteps } from '@frontend/components/pipeline-steps';
import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { CommitDto, ConfigIssueDto } from '@mocco/common/integration';

const SHA_SHORT_LENGTH = 7;

/** Triggers a run for this commit, then navigates to the new run page. Enabled
 * only when the commit's config is runnable (`present && valid`); otherwise
 * disabled with a hint (the server enforces the same guard — this is UX only). */
function RunButton({
  workspaceId,
  commitId,
  isRunnable,
}: {
  workspaceId: string;
  commitId: string;
  isRunnable: boolean;
}) {
  const router = useRouter();
  const { mutateAsync: trigger, isPending } = trpc.run.trigger.useMutation();

  const run = async (): Promise<void> => {
    const { run: created } = await trigger({ workspaceId, commitId });
    await router.push(Routes.workspaceRun(workspaceId, created.id));
  };

  return (
    <Button
      pending={isPending}
      disabled={!isRunnable}
      title={isRunnable ? undefined : 'This commit has no valid .mocco.yml to run.'}
      onClick={() => {
        fireAndForget(run());
      }}>
      Run
    </Button>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <section className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
    </section>
  );
}

/** The commit's identity: short sha, first line of the message, and author —
 * shown above the config state regardless of whether it's pending/absent/valid/invalid. */
function CommitHeader({ commit }: { commit: CommitDto }) {
  const [firstLine] = commit.message.split('\n', 1);
  return (
    <header className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <code className="shrink-0 text-xs text-muted-foreground">{commit.sha.slice(0, SHA_SHORT_LENGTH)}</code>
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{firstLine ?? commit.message}</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        {commit.authorName} &middot; {commit.committedAt.toLocaleString()}
      </p>
    </header>
  );
}

/** The `issues` list from an invalid `.mocco.yml` parse — path + message per issue. */
function ConfigIssues({ issues }: { issues: ConfigIssueDto[] }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-destructive/40 px-4 py-3">
      <h2 className="text-sm font-medium text-destructive">Invalid .mocco.yml</h2>
      <ul className="flex flex-col gap-2">
        {issues.map(issue => (
          <li key={`${issue.path}:${issue.message}`} className="text-sm">
            <code className="text-xs text-muted-foreground">{issue.path}</code>
            <span className="ml-2">{issue.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A single commit's detail: its identity plus the `.mocco.yml` snapshot taken
 * when it was synced. Read-only — the server already fetched/parsed/snapshotted
 * this at sync time; nothing here re-parses or edits. */
export function CommitDetail({ workspaceId, commitId }: { workspaceId: string; commitId: string }) {
  // retry:false — a bad/cross-tenant commitId is a permanent NOT_FOUND, not a transient failure.
  const query = trpc.integration.commitDetail.useQuery({ workspaceId, commitId }, { retry: false });

  if (query.isPending) {
    return <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />;
  }

  if (query.isError) {
    return <EmptyState title="Commit not found" body="This commit doesn't exist, or you don't have access to it." />;
  }

  const { commit, config } = query.data;
  const isRunnable = config !== null && config.present && config.valid;

  const body = (() => {
    if (config === null) {
      return (
        <EmptyState
          title="Config pending"
          body="This commit hasn't been synced yet — its .mocco.yml snapshot is not ready."
        />
      );
    }
    if (!config.present) {
      return <EmptyState title="No .mocco.yml at this commit" body="This commit's tree has no .mocco.yml file." />;
    }
    if (!config.valid) {
      return <ConfigIssues issues={config.issues} />;
    }
    // valid:true guarantees a parsed config alongside it; fall back defensively if that invariant is ever violated.
    if (config.valid && config.config) {
      return <PipelineSteps config={config.config} />;
    }
    return <EmptyState title="Configuration unavailable" body="This commit's config snapshot is incomplete." />;
  })();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <CommitHeader commit={commit} />
        <RunButton workspaceId={workspaceId} commitId={commitId} isRunnable={isRunnable} />
      </div>
      {body}
    </div>
  );
}
