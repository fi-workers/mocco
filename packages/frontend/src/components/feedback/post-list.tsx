// A board's posts on its public page (#175). The page is rendered with the most voted posts, so
// a crawler or a browser without JavaScript reads them. Filters live in the address
// (`?status=&category=&sort=`): with any of them, or for the next page, the browser fetches the
// posts from the site's feedback routes.
import { FeedbackPostStatuses, feedbackPostStatusSchema } from '@mocco/common/feedback';
import { feedbackV1PostListSchema, FeedbackPublicSorts } from '@mocco/common/feedback-v1';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

import { boardPath, postPath } from '@frontend/components/feedback/feedback-site-layout';
import { feedbackCall, feedbackStatusLabels } from '@frontend/lib/feedback-client';
import { cn } from '@frontend/lib/utils';

import type { FeedbackPageBoard } from '@mocco/backend/sites/feedback';
import type { FeedbackPublicSort, FeedbackV1Post } from '@mocco/common/feedback-v1';

const filterOf = (value: string | string[] | undefined) => (typeof value === 'string' ? value : undefined);

interface ListFilter {
  status: FeedbackV1Post['status'] | undefined;
  category: string | undefined;
  sort: FeedbackPublicSort;
}

/** A page of the board's posts from `offset`, or undefined when the call failed. */
async function fetchPosts(site: string, board: string, filter: ListFilter, offset: number) {
  const query = new URLSearchParams({
    sort: filter.sort,
    offset: String(offset),
    ...(filter.status !== undefined && { status: filter.status }),
    ...(filter.category !== undefined && { category: filter.category }),
  });
  const result = await feedbackCall(site, `/boards/${board}/posts?${query.toString()}`, feedbackV1PostListSchema);
  return result.ok ? result.data : undefined;
}

export function StatusBadge({ status }: { status: FeedbackV1Post['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full border border-border px-2 text-xs font-medium',
        status === FeedbackPostStatuses.shipped && 'border-foreground bg-foreground text-background',
      )}>
      {feedbackStatusLabels[status]}
    </span>
  );
}

function PostRow({ board, post }: { board: string; post: FeedbackV1Post }) {
  return (
    <li className="flex items-start gap-4 rounded-xl border border-border p-4">
      <div className="flex w-12 shrink-0 flex-col items-center rounded-md border border-border py-1">
        <span className="text-lg leading-tight font-semibold tabular-nums">{post.voteCount}</span>
        <span className="text-xs text-muted-foreground">{post.voteCount === 1 ? 'vote' : 'votes'}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <a href={postPath(board, post.number)} className="font-medium underline-offset-2 hover:underline">
          {post.title}
        </a>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge status={post.status} />
          <span>
            {post.commentCount} {post.commentCount === 1 ? 'comment' : 'comments'}
          </span>
        </div>
      </div>
    </li>
  );
}

export default function PostList({
  site,
  board,
  initial,
}: {
  site: string;
  board: FeedbackPageBoard;
  initial: { posts: FeedbackV1Post[]; nextOffset: number | null };
}) {
  const router = useRouter();
  const status = feedbackPostStatusSchema.safeParse(filterOf(router.query.status)).data;
  const category = board.categories.find(entry => entry.slug === filterOf(router.query.category))?.slug;
  const sort =
    filterOf(router.query.sort) === FeedbackPublicSorts.new ? FeedbackPublicSorts.new : FeedbackPublicSorts.top;
  const isFiltered = status !== undefined || category !== undefined || sort !== FeedbackPublicSorts.top;
  const [fetched, setFetched] = useState<{ key: string; posts: FeedbackV1Post[]; nextOffset: number | null } | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const key = `${status ?? ''}|${category ?? ''}|${sort}`;

  useEffect(() => {
    let isCurrent = true;
    if (isFiltered) {
      // eslint-disable-next-line no-void -- an effect can't await; fetchPosts() never rejects
      void fetchPosts(site, board.slug, { status, category, sort }, 0).then(page => {
        if (isCurrent && page !== undefined) {
          setFetched({ key, ...page });
        }
      });
    }
    return () => {
      isCurrent = false;
    };
  }, [site, board.slug, key, status, category, sort, isFiltered]);

  const initialShown = isFiltered ? null : { key, ...initial };
  const shown = fetched?.key === key ? fetched : initialShown;

  const loadMore = async () => {
    if (shown?.nextOffset === null || shown === null) {
      return;
    }
    setIsLoading(true);
    const page = await fetchPosts(site, board.slug, { status, category, sort }, shown.nextOffset);
    setIsLoading(false);
    if (page !== undefined) {
      setFetched({ key, posts: [...shown.posts, ...page.posts], nextOffset: page.nextOffset });
    }
  };

  const linkTo = (change: Record<string, string | undefined>) => {
    const next = { status, category, sort: sort === FeedbackPublicSorts.top ? undefined : sort, ...change };
    const params = new URLSearchParams(
      Object.entries(next).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
    ).toString();
    return params === '' ? boardPath(board.slug) : `${boardPath(board.slug)}?${params}`;
  };

  const chip = (label: string, href: string | undefined, isActive: boolean) => (
    <a
      key={label}
      href={href}
      aria-current={isActive ? 'true' : undefined}
      onClick={event => {
        event.preventDefault();
        // eslint-disable-next-line no-void -- a click handler can't await a shallow route change
        void router.replace(href ?? '', undefined, { shallow: true, scroll: false });
      }}
      className={cn(
        'rounded-full border border-border px-3 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
        isActive && 'border-foreground bg-foreground text-background hover:bg-foreground hover:text-background',
      )}>
      {label}
    </a>
  );

  return (
    <section aria-label="Posts" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {chip('Top', linkTo({ sort: undefined }), sort === FeedbackPublicSorts.top)}
          {chip('New', linkTo({ sort: FeedbackPublicSorts.new }), sort === FeedbackPublicSorts.new)}
          <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          {chip('All', linkTo({ status: undefined }), status === undefined)}
          {Object.values(FeedbackPostStatuses).map(value =>
            chip(feedbackStatusLabels[value], linkTo({ status: value }), status === value),
          )}
        </div>
        {board.categories.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-2">
            {chip('Every category', linkTo({ category: undefined }), category === undefined)}
            {board.categories.map(entry => chip(entry.name, linkTo({ category: entry.slug }), category === entry.slug))}
          </div>
        )}
      </div>
      {shown === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {shown?.posts.length === 0 ? <p className="text-sm text-muted-foreground">No posts here yet.</p> : null}
      <ul className="flex flex-col gap-3">
        {(shown?.posts ?? []).map(post => (
          <PostRow key={post.id} board={board.slug} post={post} />
        ))}
      </ul>
      {shown !== null && shown.nextOffset !== null ? (
        <button
          type="button"
          disabled={isLoading}
          onClick={() => {
            // eslint-disable-next-line no-void -- a click handler can't await; loadMore() never rejects
            void loadMore();
          }}
          className="h-9 self-center rounded-md border border-border px-4 text-sm hover:bg-muted disabled:opacity-60">
          {isLoading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </section>
  );
}
