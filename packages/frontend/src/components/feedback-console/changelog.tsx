// A board's changelog in the console (#176): its entries by state (drafts, scheduled, published,
// or all), newest first, and a new draft. The board and the state are in the address, like the
// inbox's filters. Each entry opens in its editor (changelog-entry.tsx).
import { ChangelogEntryStates } from '@mocco/common/feedback';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import {
  Ago,
  errorMessage,
  inputClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { changelogStateLabels, changelogStateTones, formatWhen } from '@frontend/lib/feedback-console';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { ChangelogEntryState } from '@mocco/common/feedback';

interface Props {
  workspaceId: string;
  projectId: string;
}

const ALL = 'all';
type StateFilter = ChangelogEntryState | typeof ALL;
const stateFilters: readonly StateFilter[] = [...Object.values(ChangelogEntryStates), ALL];
const filterLabel = (filter: StateFilter) => (filter === ALL ? 'All' : changelogStateLabels[filter]);

/** Start a draft on the board and open it. */
function NewEntry({ workspaceId, projectId, boardId }: Props & { boardId: string }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const create = trpc.changelog.create.useMutation({
    onSuccess: async ({ entry }) => {
      await router.push(Routes.projectFeedbackChangelogEntry(workspaceId, projectId, entry.id));
    },
  });
  // eslint-disable-next-line sonarjs/null-dereference -- title is a useState<string>, never null
  const trimmed = title.trim();
  return (
    <form
      aria-label="New changelog entry"
      className="flex flex-wrap items-center gap-2"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({ workspaceId, projectId, boardId, title: trimmed });
      }}>
      <input
        aria-label="Title of the new entry"
        placeholder="What shipped? e.g. Dark mode is here"
        value={title}
        maxLength={200}
        onChange={event => {
          setTitle(event.target.value);
        }}
        className={`${inputClass} min-w-64 flex-1`}
      />
      <Button type="submit" className="text-sm" disabled={trimmed === ''} pending={create.isPending}>
        New entry
      </Button>
      {create.error ? <p className="w-full text-sm text-destructive">{errorMessage(create.error)}</p> : null}
    </form>
  );
}

export default function FeedbackChangelog({ workspaceId, projectId }: Props) {
  const router = useRouter();
  const boardsQuery = trpc.feedback.boards.useQuery({ workspaceId, projectId });
  const boards = boardsQuery.data?.boards ?? [];
  const asked = typeof router.query.board === 'string' ? router.query.board : undefined;
  const board = boards.find(entry => entry.slug === asked) ?? boards[0];
  const askedState = typeof router.query.state === 'string' ? router.query.state : undefined;
  const state: StateFilter = stateFilters.find(filter => filter === askedState) ?? ALL;
  const entriesQuery = trpc.changelog.entries.useQuery(
    {
      workspaceId,
      projectId,
      boardId: board?.id ?? '',
      limit: 100,
      ...(state !== ALL && { state }),
    },
    { enabled: board !== undefined },
  );

  if (boardsQuery.isPending) {
    return <Spinner />;
  }
  if (boardsQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(boardsQuery.error)}</p>;
  }
  if (board === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        A changelog belongs to a board.{' '}
        <Link href={Routes.projectFeedback(workspaceId, projectId)} className="underline underline-offset-2">
          Create a board
        </Link>{' '}
        first.
      </p>
    );
  }
  const entries = entriesQuery.data?.entries ?? [];
  const hrefFor = (change: { board?: string; state?: StateFilter }) => {
    const nextState = change.state ?? state;
    return Routes.projectFeedbackChangelog(workspaceId, projectId, {
      board: change.board ?? board.slug,
      ...(nextState !== ALL && { state: nextState }),
    });
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={Routes.projectFeedback(workspaceId, projectId, { board: board.slug })}
          className="text-xs text-muted-foreground hover:text-foreground">
          ← Inbox
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Changelog</h2>
        {boards.length > 1 ? (
          <select
            aria-label="Board"
            className={`${inputClass} w-auto`}
            value={board.slug}
            onChange={async event => {
              await router.replace(hrefFor({ board: event.target.value, state: ALL }), undefined, { shallow: true });
            }}>
            {boards.map(entry => (
              <option key={entry.id} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm text-muted-foreground">{board.name}</span>
        )}
      </div>
      <NewEntry workspaceId={workspaceId} projectId={projectId} boardId={board.id} />
      <nav aria-label="State" className="flex flex-wrap gap-1 border-b border-border">
        {stateFilters.map(value => (
          <Link
            key={value}
            href={hrefFor({ state: value })}
            shallow
            aria-current={value === state ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              value === state ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground'
            }`}>
            {filterLabel(value)}
          </Link>
        ))}
      </nav>
      {entriesQuery.isPending ? <Spinner /> : null}
      {entriesQuery.error ? <p className="text-sm text-destructive">{errorMessage(entriesQuery.error)}</p> : null}
      {entriesQuery.isSuccess && entries.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No entries here yet. Write one when something ships.
        </p>
      ) : null}
      {entries.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {entries.map(entry => (
            <li key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Link
                href={Routes.projectFeedbackChangelogEntry(workspaceId, projectId, entry.id)}
                className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-2 hover:underline">
                {entry.title}
              </Link>
              <StatusBadge tone={changelogStateTones[entry.state]}>{changelogStateLabels[entry.state]}</StatusBadge>
              {entry.tags.map(tag => (
                <StatusBadge key={tag} tone={Tones.neutral}>
                  {tag}
                </StatusBadge>
              ))}
              <span className="text-xs text-muted-foreground">
                {entry.postIds.length} {entry.postIds.length === 1 ? 'post' : 'posts'}
              </span>
              <span className="text-xs text-muted-foreground">
                {entry.publishedAt !== null && <>Published {formatWhen(entry.publishedAt)}</>}
                {entry.publishAt !== null && <>Goes out {formatWhen(entry.publishAt)}</>}
                {entry.publishedAt === null && entry.publishAt === null && (
                  <>
                    Edited <Ago date={entry.updatedAt} />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
