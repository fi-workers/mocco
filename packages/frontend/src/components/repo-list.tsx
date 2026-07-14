import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { fireAndForget } from '@/lib/fire-and-forget';
import { trpc } from '@/lib/trpc';

import type { ConnectionDto, RepoDto } from '@mocco/common/integration';

const inputClass = 'h-9 w-44 rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring';

/** A connected repo row: shows owner/name and an editable watched branch. */
function ConnectedRepoRow({ workspaceId, repo }: { workspaceId: string; repo: RepoDto }) {
  const utils = trpc.useUtils();
  const initialBranch = repo.watchedBranch ?? repo.defaultBranch;
  const [branch, setBranch] = useState(initialBranch);
  const { mutateAsync: setWatchedBranch, isPending } = trpc.integration.setWatchedBranch.useMutation();

  const save = async (): Promise<void> => {
    // eslint-disable-next-line sonarjs/null-dereference -- branch is a useState<string> seeded from a non-null value
    const trimmed = branch.trim();
    await setWatchedBranch({ workspaceId, repoId: repo.id, watchedBranch: trimmed === '' ? null : trimmed });
    await utils.integration.repos.invalidate();
  };

  return (
    <li className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
      <span className="flex-1 truncate text-sm font-medium">
        {repo.owner}/{repo.name}
      </span>
      <input
        aria-label={`Watched branch for ${repo.owner}/${repo.name}`}
        className={inputClass}
        value={branch}
        placeholder={repo.defaultBranch}
        onChange={event => {
          setBranch(event.target.value);
        }}
      />
      <Button
        variant="secondary"
        pending={isPending}
        onClick={() => {
          fireAndForget(save());
        }}>
        Save
      </Button>
    </li>
  );
}

/** Lists repos accessible to a connection that aren't registered yet, each with an Add button. */
function AddRepoSection({
  workspaceId,
  connection,
  connectedIds,
}: {
  workspaceId: string;
  connection: ConnectionDto;
  connectedIds: ReadonlySet<string>;
}) {
  const utils = trpc.useUtils();
  const availableQuery = trpc.integration.availableRepos.useQuery(
    { workspaceId, connectionId: connection.id },
    { retry: false },
  );
  const { mutateAsync: addRepo, isPending } = trpc.integration.addRepo.useMutation();

  const available = (availableQuery.data?.repos ?? []).filter(repo => !connectedIds.has(repo.externalRepoId));

  const add = async (externalRepoId: string, defaultBranch: string): Promise<void> => {
    await addRepo({ workspaceId, connectionId: connection.id, externalRepoId, watchedBranch: defaultBranch });
    await utils.integration.repos.invalidate();
  };

  const body = (() => {
    if (availableQuery.isPending) {
      return <p className="text-sm text-muted-foreground">Loading repositories…</p>;
    }
    if (available.length === 0) {
      return <p className="text-sm text-muted-foreground">No more repositories to add.</p>;
    }
    return (
      <ul className="flex flex-col gap-2">
        {available.map(repo => (
          <li key={repo.externalRepoId} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
            <span className="flex-1 truncate text-sm">
              {repo.owner}/{repo.name}
            </span>
            <Button
              variant="secondary"
              pending={isPending}
              onClick={() => {
                fireAndForget(add(repo.externalRepoId, repo.defaultBranch));
              }}>
              Add
            </Button>
          </li>
        ))}
      </ul>
    );
  })();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Add a repository from {connection.accountLogin}</h2>
      {body}
    </section>
  );
}

/** The connected repos plus an add-from-connection picker for each connection. */
export function RepoList({ workspaceId, connections }: { workspaceId: string; connections: ConnectionDto[] }) {
  const reposQuery = trpc.integration.repos.useQuery({ workspaceId }, { retry: false });
  const repos = reposQuery.data?.repos ?? [];
  const connectedIds = new Set(repos.map(repo => repo.externalRepoId));

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Connected repositories</h2>
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repositories connected yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {repos.map(repo => (
              <ConnectedRepoRow key={repo.id} workspaceId={workspaceId} repo={repo} />
            ))}
          </ul>
        )}
      </section>

      {connections.map(connection => (
        <AddRepoSection
          key={connection.id}
          workspaceId={workspaceId}
          connection={connection}
          connectedIds={connectedIds}
        />
      ))}
    </div>
  );
}
