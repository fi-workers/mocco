import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { trpc } from '@frontend/lib/trpc';

import type { CommitDto } from '@mocco/common/integration';

const COMMITS_PAGE_LIMIT = 20;
const SHA_SHORT_LENGTH = 7;

/** Largest-first list of relative-time units, paired with their length in seconds. */
const RELATIVE_TIME_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
  ['second', 1],
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const SMALLEST_UNIT: [Intl.RelativeTimeFormatUnit, number] = ['second', 1];

/** "3 minutes ago" / "yesterday" style formatting via Intl — no date library
 * needed for this single call site. */
function relativeTime(date: Date): string {
  const diffSeconds = (date.getTime() - Date.now()) / 1000;
  const [unit, secondsInUnit] =
    RELATIVE_TIME_UNITS.find(([, unitSeconds]) => Math.abs(diffSeconds) >= unitSeconds) ?? SMALLEST_UNIT;
  return relativeTimeFormatter.format(Math.round(diffSeconds / secondsInUnit), unit);
}

function messageFirstLine(message: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- false positive: message is a required string, never null/undefined
  const [firstLine] = message.split('\n', 1);
  return firstLine ?? message;
}

function CommitRow({ commit }: { commit: CommitDto }) {
  return (
    <li className="flex items-center gap-3 rounded-xl border border-border px-4 py-3">
      <code className="shrink-0 text-xs text-muted-foreground">{commit.sha.slice(0, SHA_SHORT_LENGTH)}</code>
      <span className="min-w-0 flex-1 truncate text-sm">{messageFirstLine(commit.message)}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{commit.authorName}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(commit.committedAt)}</span>
    </li>
  );
}

/** The candidate queue for a watched repo: synced commits, newest-first, paginated
 * via `nextCursor`. Read-only — no commit detail / .mocco.yml parsing (that's slice 3c). */
export function CommitQueue({ workspaceId, repoId }: { workspaceId: string; repoId: string }) {
  const query = trpc.integration.commits.useInfiniteQuery(
    { workspaceId, repoId, limit: COMMITS_PAGE_LIMIT },
    { getNextPageParam: lastPage => lastPage.nextCursor ?? undefined, initialCursor: null, retry: false },
  );

  if (query.isPending) {
    return <span className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground" />;
  }

  const commits = query.data?.pages.flatMap(page => page.commits) ?? [];

  if (commits.length === 0) {
    return <p className="text-sm text-muted-foreground">No commits synced yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {commits.map(commit => (
          <CommitRow key={commit.id} commit={commit} />
        ))}
      </ul>
      {query.hasNextPage && (
        <Button
          variant="secondary"
          size="sm"
          pending={query.isFetchingNextPage}
          onClick={() => {
            fireAndForget(query.fetchNextPage());
          }}>
          Load more
        </Button>
      )}
    </div>
  );
}
