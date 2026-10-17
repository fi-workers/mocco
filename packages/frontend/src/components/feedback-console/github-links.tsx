// A post's GitHub links in the console (#178): the issues and pull requests it is about, with the
// state GitHub last reported (open, closed, merged) and, for an issue, the pull requests that close
// it. Staff search the repos linked to the project by words or number, link one, and remove a link.
// Reads and writes only through `feedback.links`, `linkRepos`, `linkSearch`, `link` and `unlink`.
import { FeedbackLinkKinds, FeedbackLinkStates } from '@mocco/common/feedback';
import Link from 'next/link';
import { useState } from 'react';

import {
  errorMessage,
  inputClass,
  labelClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { Tone } from '@frontend/components/notifications/notification-ui';
import type { FeedbackLinkKind, FeedbackLinkState } from '@mocco/common/feedback';

interface Props {
  workspaceId: string;
  projectId: string;
  postId: string;
  isMerged: boolean;
}

const stateTones: Record<FeedbackLinkState, Tone> = {
  [FeedbackLinkStates.open]: Tones.ok,
  [FeedbackLinkStates.merged]: Tones.neutral,
  [FeedbackLinkStates.closed]: Tones.danger,
};
const stateLabels: Record<FeedbackLinkState, string> = {
  [FeedbackLinkStates.open]: 'Open',
  [FeedbackLinkStates.merged]: 'Merged',
  [FeedbackLinkStates.closed]: 'Closed',
};
const kindLabels: Record<FeedbackLinkKind, string> = {
  [FeedbackLinkKinds.issue]: 'Issue',
  [FeedbackLinkKinds.pullRequest]: 'Pull request',
};

function StateBadge({ state }: { state: FeedbackLinkState }) {
  return <StatusBadge tone={stateTones[state]}>{stateLabels[state]}</StatusBadge>;
}

/** Search the project's repos and link an issue or pull request. */
function LinkPicker({ workspaceId, projectId, postId, onDone }: Omit<Props, 'isMerged'> & { onDone: () => void }) {
  const utils = trpc.useUtils();
  const reposQuery = trpc.feedback.linkRepos.useQuery({ workspaceId, projectId });
  const repos = reposQuery.data?.repos ?? [];
  const [pickedRepoId, setPickedRepoId] = useState<string | null>(null);
  const [kind, setKind] = useState<FeedbackLinkKind>(FeedbackLinkKinds.issue);
  const [query, setQuery] = useState('');
  const repoId = pickedRepoId ?? repos.at(0)?.id ?? null;
  const searchQuery = trpc.feedback.linkSearch.useQuery(
    { workspaceId, projectId, repoId: repoId ?? '', kind, query },
    { enabled: repoId !== null },
  );
  const link = trpc.feedback.link.useMutation({
    onSuccess: async () => {
      await utils.feedback.links.invalidate({ workspaceId, projectId, postId });
      onDone();
    },
  });

  if (reposQuery.isPending) {
    return <Spinner />;
  }
  if (repos.length === 0) {
    return (
      <p className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
        No repository is linked to this project yet. Link one on the{' '}
        <Link href={Routes.project(workspaceId, projectId)} className="underline underline-offset-2">
          project page
        </Link>{' '}
        first.
      </p>
    );
  }
  const items = searchQuery.data?.items ?? [];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <label className={labelClass}>
        Repository
        <select
          className={inputClass}
          value={repoId ?? ''}
          onChange={event => {
            setPickedRepoId(event.target.value);
          }}>
          {repos.map(repo => (
            <option key={repo.id} value={repo.id}>
              {repo.owner}/{repo.name}
            </option>
          ))}
        </select>
      </label>
      <span className="flex gap-3">
        {Object.values(FeedbackLinkKinds).map(value => (
          <label key={value} className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="link-kind"
              checked={kind === value}
              onChange={() => {
                setKind(value);
              }}
            />
            {kindLabels[value]}
          </label>
        ))}
      </span>
      <input
        aria-label="Search issues and pull requests"
        placeholder="Search by title, or #number"
        value={query}
        onChange={event => {
          setQuery(event.target.value);
        }}
        className={inputClass}
      />
      {searchQuery.isFetching ? <Spinner /> : null}
      {searchQuery.error ? <p className="text-sm text-destructive">{errorMessage(searchQuery.error)}</p> : null}
      {searchQuery.error ? null : (
        <ul className="flex max-h-56 flex-col overflow-y-auto rounded-md border border-border">
          {items.map(item => (
            <li key={item.number}>
              <button
                type="button"
                disabled={link.isPending}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted/50 disabled:opacity-50"
                onClick={() => {
                  if (repoId !== null) {
                    link.mutate({ workspaceId, projectId, postId, repoId, kind, number: item.number });
                  }
                }}>
                <span className="text-xs text-muted-foreground tabular-nums">#{item.number}</span>
                <span className="flex-1 truncate">{item.title}</span>
                <StateBadge state={item.state} />
              </button>
            </li>
          ))}
          {searchQuery.isSuccess && items.length === 0 ? (
            <li className="px-2 py-1.5 text-sm text-muted-foreground">Nothing matches.</li>
          ) : null}
        </ul>
      )}
      {link.error ? <p className="text-sm text-destructive">{errorMessage(link.error)}</p> : null}
      <Button variant="ghost" className="w-fit text-sm" onClick={onDone}>
        Cancel
      </Button>
    </div>
  );
}

export function GithubLinks({ workspaceId, projectId, postId, isMerged }: Props) {
  const utils = trpc.useUtils();
  const linksQuery = trpc.feedback.links.useQuery({ workspaceId, projectId, postId });
  const unlink = trpc.feedback.unlink.useMutation({
    onSuccess: async () => {
      await utils.feedback.links.invalidate({ workspaceId, projectId, postId });
    },
  });
  const [isPicking, setIsPicking] = useState(false);
  const links = linksQuery.data?.links ?? [];
  const picker = isPicking ? (
    <LinkPicker
      workspaceId={workspaceId}
      projectId={projectId}
      postId={postId}
      onDone={() => {
        setIsPicking(false);
      }}
    />
  ) : (
    <Button
      variant="outline"
      className="w-fit text-sm"
      onClick={() => {
        setIsPicking(true);
      }}>
      Link an issue or pull request…
    </Button>
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">GitHub ({links.length})</h2>
      {linksQuery.isPending ? <Spinner /> : null}
      <ul className="flex flex-col gap-2">
        {links.map(link => (
          <li key={link.id} className="flex flex-col gap-1 rounded-lg border border-border p-3">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="shrink-0">{kindLabels[link.kind]}</span>
              {link.repo === null ? null : (
                <span className="truncate">
                  {link.repo.owner}/{link.repo.name}
                </span>
              )}
              <span className="ml-auto shrink-0">
                <StateBadge state={link.state} />
              </span>
            </span>
            <a href={link.url} target="_blank" rel="noreferrer" className="text-sm hover:underline">
              <span className="text-muted-foreground tabular-nums">#{link.externalNumber}</span> {link.title}
            </a>
            {link.mergeCommitSha === null ? null : (
              <span className="font-mono text-xs text-muted-foreground">{link.mergeCommitSha.slice(0, 7)}</span>
            )}
            {link.closers.length === 0 ? null : (
              <ul className="flex flex-col gap-1 border-l border-border pl-2">
                {link.closers.map(closer => (
                  <li key={closer.id} className="flex items-center gap-2 text-xs">
                    <a href={closer.url} target="_blank" rel="noreferrer" className="flex-1 truncate hover:underline">
                      Closed by #{closer.prNumber} {closer.title}
                    </a>
                    <StateBadge state={closer.state} />
                  </li>
                ))}
              </ul>
            )}
            <Button
              variant="ghost"
              className="w-fit text-xs"
              pending={unlink.isPending && unlink.variables.linkId === link.id}
              onClick={() => {
                unlink.mutate({ workspaceId, projectId, linkId: link.id });
              }}>
              Unlink
            </Button>
          </li>
        ))}
      </ul>
      {unlink.error ? <p className="text-sm text-destructive">{errorMessage(unlink.error)}</p> : null}
      {isMerged ? null : picker}
    </section>
  );
}
