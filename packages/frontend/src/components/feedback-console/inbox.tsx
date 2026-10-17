// The project's feedback inbox (#175): one board's posts for the team to triage, under review and
// newest first unless the address says otherwise. The board, status, category and sort live in
// the query string (`?board=ideas&status=planned&category=mobile&sort=top`), so a filtered inbox
// can be shared and survives a reload. A project without boards starts by creating one.
import { FeedbackPostSorts, FeedbackPostStatuses, FeedbackLimits } from '@mocco/common/feedback';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { BoardForm } from '@frontend/components/feedback-console/boards';
import {
  Ago,
  errorMessage,
  inputClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { feedbackStatusLabels } from '@frontend/lib/feedback-client';
import { publicBoardUrl, sortLabels, statusTones, useHelpSiteSlug } from '@frontend/lib/feedback-console';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { FeedbackPostSort, FeedbackPostStatus } from '@mocco/common/feedback';
import type { inferRouterOutputs } from '@trpc/server';

type Post = inferRouterOutputs<AppRouter>['feedback']['posts']['posts'][number];

interface Props {
  workspaceId: string;
  projectId: string;
}

/** How often the inbox looks for new posts and votes while open (no realtime in v1). */
const FEEDBACK_INBOX_REFRESH_MS = 30_000;

/** Posts per page of the inbox. */
const PAGE_SIZE = FeedbackLimits.listDefault;

/** `?status=all` lists every status; without one the inbox shows what still needs a decision. */
const ALL = 'all';
type StatusFilter = FeedbackPostStatus | typeof ALL;
const statusFilters: readonly StatusFilter[] = [...Object.values(FeedbackPostStatuses), ALL];
const statusFilterLabel = (filter: StatusFilter) => (filter === ALL ? 'All' : feedbackStatusLabels[filter]);

const queryString = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
const isIn = <T extends string>(values: readonly T[], value: string | undefined): value is T =>
  value !== undefined && (values as readonly string[]).includes(value);

/** What the inbox shows, as the address says it. A missing or unknown value is the default. */
interface InboxFilters {
  /** The board's slug; undefined = the first board. */
  board: string | undefined;
  status: StatusFilter;
  /** The category's slug; undefined = every category. */
  category: string | undefined;
  sort: FeedbackPostSort;
}
const DEFAULT_STATUS: StatusFilter = FeedbackPostStatuses.underReview;
const DEFAULT_SORT: FeedbackPostSort = FeedbackPostSorts.newest;

function filtersOf(query: Readonly<Record<string, unknown>>): InboxFilters {
  const status = queryString(query.status);
  const sort = queryString(query.sort);
  return {
    board: queryString(query.board),
    status: isIn(statusFilters, status) ? status : DEFAULT_STATUS,
    category: queryString(query.category),
    sort: isIn(Object.values(FeedbackPostSorts), sort) ? sort : DEFAULT_SORT,
  };
}

/** The inbox's address for these filters, leaving defaults out. */
function inboxHref(workspaceId: string, projectId: string, filters: InboxFilters): string {
  return Routes.projectFeedback(workspaceId, projectId, {
    ...(filters.board !== undefined && { board: filters.board }),
    ...(filters.status !== DEFAULT_STATUS && { status: filters.status }),
    ...(filters.category !== undefined && { category: filters.category }),
    ...(filters.sort !== DEFAULT_SORT && { sort: filters.sort }),
  });
}

function FirstBoard({ workspaceId, projectId }: Props) {
  return (
    <section className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Create your first board</h2>
        <p className="text-sm text-muted-foreground">
          A board collects what your users want next: they post ideas and vote, and you move them from under review to
          planned, in progress and shipped. A public board gets its own page on your help center site.
        </p>
      </div>
      <BoardForm workspaceId={workspaceId} projectId={projectId} />
    </section>
  );
}

/** One post in the inbox: its votes, number, title, status and what's around it. */
function PostRow({ post, categoryName, href }: { post: Post; categoryName: string | undefined; href: string }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="flex w-12 shrink-0 flex-col items-center rounded-md border border-border py-0.5">
        <span className="text-sm leading-tight font-semibold tabular-nums">{post.voteCount}</span>
        <span className="text-[10px] text-muted-foreground">{post.voteCount === 1 ? 'vote' : 'votes'}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">#{post.number}</span>
          <Link href={href} className="text-sm font-medium underline-offset-2 hover:underline">
            {post.title}
          </Link>
        </span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge tone={statusTones[post.status]}>{feedbackStatusLabels[post.status]}</StatusBadge>
          {post.mergedIntoPostId === null ? null : <StatusBadge tone={Tones.neutral}>Merged</StatusBadge>}
          {categoryName === undefined ? null : <span>{categoryName}</span>}
          <span>
            {post.commentCount} {post.commentCount === 1 ? 'comment' : 'comments'}
          </span>
          <span>{post.authorEndUserId === null ? 'Posted by the team' : 'Posted by a user'}</span>
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        <Ago date={post.createdAt} />
      </span>
    </li>
  );
}

type Board = inferRouterOutputs<AppRouter>['feedback']['boards']['boards'][number];
type Category = inferRouterOutputs<AppRouter>['feedback']['board']['categories'][number];

/** The board picker, status tabs, category and sort; each change is a new address. */
function Filters({
  boards,
  board,
  categories,
  filters,
  hrefWith,
  publicUrl,
  manageHref,
  changelogHref,
  duplicatesHref,
  duplicateCount,
  onChange,
}: {
  boards: readonly Board[];
  board: Board;
  categories: readonly Category[];
  filters: InboxFilters;
  hrefWith: (change: Partial<InboxFilters>) => string;
  publicUrl: string | null;
  manageHref: string;
  changelogHref: string;
  duplicatesHref: string;
  duplicateCount: number;
  onChange: (href: string | null) => Promise<void>;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Board"
          className={`${inputClass} w-auto`}
          value={board.slug}
          onChange={async event => {
            await onChange(hrefWith({ board: event.target.value }));
          }}>
          {boards.map(entry => (
            <option key={entry.id} value={entry.slug}>
              {entry.isPublic ? entry.name : `${entry.name} (private)`}
            </option>
          ))}
        </select>
        {publicUrl === null ? null : (
          <a href={publicUrl} target="_blank" rel="noreferrer" className="text-sm underline underline-offset-2">
            Public page
          </a>
        )}
        <Link
          href={duplicatesHref}
          className="ml-auto text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Possible duplicates{duplicateCount === 0 ? '' : ` (${String(duplicateCount)})`}
        </Link>
        <Link
          href={changelogHref}
          className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Changelog
        </Link>
        <Link
          href={manageHref}
          className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Manage boards
        </Link>
      </div>

      <nav aria-label="Status" className="flex flex-wrap gap-1 border-b border-border">
        {statusFilters.map(value => (
          <Link
            key={value}
            href={hrefWith({ status: value })}
            shallow
            scroll={false}
            onClick={async () => {
              await onChange(null);
            }}
            aria-current={value === filters.status ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              value === filters.status ? 'border-foreground font-medium' : 'border-transparent text-muted-foreground'
            }`}>
            {statusFilterLabel(value)}
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap items-center gap-2">
        {categories.length === 0 ? null : (
          <select
            aria-label="Category"
            className={`${inputClass} w-auto`}
            value={filters.category ?? ''}
            onChange={async event => {
              await onChange(hrefWith({ category: event.target.value === '' ? undefined : event.target.value }));
            }}>
            <option value="">Every category</option>
            {categories.map(entry => (
              <option key={entry.id} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="Sort"
          className={`${inputClass} w-auto`}
          value={filters.sort}
          onChange={async event => {
            await onChange(hrefWith({ sort: event.target.value as FeedbackPostSort }));
          }}>
          {Object.values(FeedbackPostSorts).map(value => (
            <option key={value} value={value}>
              {sortLabels[value]}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

/** Previous and next pages, with the range shown; nothing when it all fits on one page. */
function Pager({ offset, count, onMove }: { offset: number; count: number; onMove: (offset: number) => void }) {
  if (offset === 0 && count < PAGE_SIZE) {
    return null;
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <Button
        variant="outline"
        className="text-sm"
        disabled={offset === 0}
        onClick={() => {
          onMove(Math.max(0, offset - PAGE_SIZE));
        }}>
        Previous
      </Button>
      <Button
        variant="outline"
        className="text-sm"
        disabled={count < PAGE_SIZE}
        onClick={() => {
          onMove(offset + PAGE_SIZE);
        }}>
        Next
      </Button>
      <span className="text-muted-foreground tabular-nums">
        {offset + 1}–{offset + count}
      </span>
    </div>
  );
}

/** One board's inbox, filtered as the address says. */
function BoardInbox({
  workspaceId,
  projectId,
  boards,
  board,
  filters,
  siteSlug,
}: Props & { boards: readonly Board[]; board: Board; filters: InboxFilters; siteSlug: string | null }) {
  const router = useRouter();
  const [offset, setOffset] = useState(0);
  const boardQuery = trpc.feedback.board.useQuery({ workspaceId, projectId, boardId: board.id });
  const categories = boardQuery.data?.categories ?? [];
  const category = categories.find(entry => entry.slug === filters.category);
  const postsQuery = trpc.feedback.posts.useQuery(
    {
      workspaceId,
      projectId,
      boardId: board.id,
      sort: filters.sort,
      limit: PAGE_SIZE,
      offset,
      ...(filters.status !== ALL && { status: filters.status }),
      ...(category !== undefined && { categoryId: category.id }),
    },
    { refetchInterval: FEEDBACK_INBOX_REFRESH_MS, placeholderData: previous => previous },
  );
  const posts = postsQuery.data?.posts ?? [];
  // Only the count, for the link to the queue.
  const duplicatesQuery = trpc.feedback.duplicates.useQuery(
    { workspaceId, projectId, boardId: board.id, limit: 1 },
    { refetchInterval: FEEDBACK_INBOX_REFRESH_MS },
  );

  /** The inbox's address with one filter changed; another board starts from its defaults. */
  const hrefWith = (change: Partial<InboxFilters>) =>
    inboxHref(
      workspaceId,
      projectId,
      change.board === undefined
        ? { ...filters, board: board.slug, ...change }
        : { board: change.board, status: DEFAULT_STATUS, category: undefined, sort: DEFAULT_SORT },
    );

  return (
    <section className="flex flex-col gap-4">
      <Filters
        boards={boards}
        board={board}
        categories={categories}
        filters={filters}
        hrefWith={hrefWith}
        publicUrl={siteSlug === null || !board.isPublic ? null : publicBoardUrl(siteSlug, board.slug)}
        manageHref={Routes.projectFeedbackBoards(workspaceId, projectId)}
        changelogHref={Routes.projectFeedbackChangelog(workspaceId, projectId, { board: board.slug })}
        duplicatesHref={Routes.projectFeedbackDuplicates(workspaceId, projectId, { board: board.slug })}
        duplicateCount={duplicatesQuery.data?.openCount ?? 0}
        onChange={async href => {
          setOffset(0);
          if (href !== null) {
            await router.replace(href, undefined, { shallow: true, scroll: false });
          }
        }}
      />
      {postsQuery.isPending ? <Spinner /> : null}
      {postsQuery.error ? <p className="text-sm text-destructive">{errorMessage(postsQuery.error)}</p> : null}
      {postsQuery.isSuccess && posts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {filters.status === DEFAULT_STATUS ? 'Nothing waiting for review.' : 'No posts here.'}
        </p>
      ) : null}
      {posts.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {posts.map(post => (
            <PostRow
              key={post.id}
              post={post}
              categoryName={categories.find(entry => entry.id === post.categoryId)?.name}
              href={Routes.projectFeedbackPost(workspaceId, projectId, post.id)}
            />
          ))}
        </ul>
      )}
      <Pager offset={offset} count={posts.length} onMove={setOffset} />
    </section>
  );
}

export default function FeedbackInbox({ workspaceId, projectId }: Props) {
  const router = useRouter();
  const boardsQuery = trpc.feedback.boards.useQuery({ workspaceId, projectId });
  const siteSlug = useHelpSiteSlug(workspaceId, projectId);
  if (boardsQuery.isPending) {
    return <Spinner />;
  }
  if (boardsQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(boardsQuery.error)}</p>;
  }
  const filters = filtersOf(router.query);
  const { boards } = boardsQuery.data;
  const board = boards.find(entry => entry.slug === filters.board) ?? boards[0];
  if (board === undefined) {
    return <FirstBoard workspaceId={workspaceId} projectId={projectId} />;
  }
  return (
    <BoardInbox
      // Another board starts on its first page.
      key={board.id}
      workspaceId={workspaceId}
      projectId={projectId}
      boards={boards}
      board={board}
      filters={filters}
      siteSlug={siteSlug}
    />
  );
}
