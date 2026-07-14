import { useRouter } from 'next/router';

import { ConnectGithubButton } from '@/components/connect-github-button';
import { RepoList } from '@/components/repo-list';
import { trpc } from '@/lib/trpc';

function noticeFor(query: ReturnType<typeof useRouter>['query']): string | null {
  if (query.connect_error === '1') {
    return "We couldn't complete the GitHub connection. Please try again.";
  }
  if (query.pending === '1') {
    return 'Your GitHub installation is awaiting an organization admin’s approval.';
  }
  return null;
}

// A workspace's Overview section: connect a GitHub App, then register repositories
// and choose the branch mocco watches. Read-only observation for now — deploys are
// gated in later slices.
export default function WorkspaceOverview({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  // retry:false — a PRECONDITION_FAILED (GitHub App not configured) or NOT_FOUND is
  // permanent; retrying only keeps the page spinning. Treat "no data" as no connections.
  const connectionsQuery = trpc.integration.connections.useQuery({ workspaceId }, { retry: false });
  const connections = connectionsQuery.data?.connections ?? [];
  const notice = noticeFor(router.query);

  const content = (() => {
    if (connectionsQuery.isPending) {
      return <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />;
    }
    if (connections.length === 0) {
      return (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-16 text-center">
          <h2 className="text-sm font-medium">No repositories yet</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Connect GitHub to import repositories and start gating their deploys.
          </p>
          <ConnectGithubButton workspaceId={workspaceId} />
        </section>
      );
    }
    return <RepoList workspaceId={workspaceId} connections={connections} />;
  })();

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Repositories</h1>
        <p className="text-sm text-muted-foreground">The repositories in this workspace and the deploys mocco gates.</p>
      </header>

      {notice ? <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">{notice}</p> : null}

      {content}
    </div>
  );
}
