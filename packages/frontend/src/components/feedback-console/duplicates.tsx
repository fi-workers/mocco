// A board's suggested duplicates in the console (#181): pairs of posts whose titles share most of
// their words, found by a sweep a minute or so after a post arrives. Each pair is merged (the
// newer post into the older one, as on the post page) or set aside as not the same request, and
// a pair set aside isn't suggested again. The board is in the address, like the inbox's filters.
import Link from 'next/link';
import { useRouter } from 'next/router';

import {
  Ago,
  errorMessage,
  inputClass,
  Spinner,
  StatusBadge,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { feedbackStatusLabels } from '@frontend/lib/feedback-client';
import { statusTones } from '@frontend/lib/feedback-console';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { inferRouterOutputs } from '@trpc/server';

interface Props {
  workspaceId: string;
  projectId: string;
}

type Pair = inferRouterOutputs<AppRouter>['feedback']['duplicates']['pairs'][number];
type PairPost = Pair['post'];

function PostCell({ workspaceId, projectId, post }: Props & { post: PairPost }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">#{post.number}</span>
        <Link
          href={Routes.projectFeedbackPost(workspaceId, projectId, post.id)}
          className="truncate text-sm font-medium underline-offset-2 hover:underline">
          {post.title}
        </Link>
      </span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge tone={statusTones[post.status]}>{feedbackStatusLabels[post.status]}</StatusBadge>
        <span>
          {post.voteCount} {post.voteCount === 1 ? 'vote' : 'votes'}
        </span>
        <Ago date={post.createdAt} />
      </span>
    </span>
  );
}

function PairRow({ workspaceId, projectId, pair }: Props & { pair: Pair }) {
  const utils = trpc.useUtils();
  const refresh = async () => {
    await Promise.all([utils.feedback.duplicates.invalidate(), utils.feedback.posts.invalidate()]);
  };
  const merge = trpc.feedback.mergePost.useMutation({ onSuccess: refresh });
  const dismiss = trpc.feedback.dismissDuplicate.useMutation({ onSuccess: refresh });
  const error = merge.error ?? dismiss.error;
  const isBusy = merge.isPending || dismiss.isPending;
  const { post, original } = pair;

  return (
    <li
      aria-label={`#${String(post.number)} and #${String(original.number)}`}
      className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <PostCell workspaceId={workspaceId} projectId={projectId} post={post} />
        <span className="shrink-0 text-xs text-muted-foreground">may be the same as</span>
        <PostCell workspaceId={workspaceId} projectId={projectId} post={original} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {Math.round(pair.score * 100)}% of #{post.number}&apos;s title words are in #{original.number}&apos;s
        </span>
        <Button
          className="ml-auto text-sm"
          disabled={isBusy}
          pending={merge.isPending}
          onClick={() => {
            merge.mutate({ workspaceId, projectId, postId: post.id, intoPostId: original.id });
          }}>
          Merge #{post.number} into #{original.number}
        </Button>
        <Button
          variant="outline"
          className="text-sm"
          disabled={isBusy}
          pending={dismiss.isPending}
          onClick={() => {
            dismiss.mutate({ workspaceId, projectId, duplicateId: pair.id });
          }}>
          Not the same
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
    </li>
  );
}

export default function FeedbackDuplicates({ workspaceId, projectId }: Props) {
  const router = useRouter();
  const boardsQuery = trpc.feedback.boards.useQuery({ workspaceId, projectId });
  const boards = boardsQuery.data?.boards ?? [];
  const asked = typeof router.query.board === 'string' ? router.query.board : undefined;
  const board = boards.find(entry => entry.slug === asked) ?? boards[0];
  const pairsQuery = trpc.feedback.duplicates.useQuery(
    { workspaceId, projectId, boardId: board?.id ?? '', limit: 100 },
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
        <Link href={Routes.projectFeedback(workspaceId, projectId)} className="underline underline-offset-2">
          Create a board
        </Link>{' '}
        first.
      </p>
    );
  }
  const pairs = pairsQuery.data?.pairs ?? [];

  return (
    <section className="flex flex-col gap-4">
      <Link
        href={Routes.projectFeedback(workspaceId, projectId, { board: board.slug })}
        className="text-xs text-muted-foreground hover:text-foreground">
        ← Inbox
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Possible duplicates</h2>
        {boards.length > 1 ? (
          <select
            aria-label="Board"
            className={`${inputClass} w-auto`}
            value={board.slug}
            onChange={async event => {
              await router.replace(
                Routes.projectFeedbackDuplicates(workspaceId, projectId, { board: event.target.value }),
                undefined,
                { shallow: true },
              );
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
      <p className="text-sm text-muted-foreground">
        New posts are compared with the board&apos;s older ones by the words in their titles. Merging moves the newer
        post&apos;s votes and followers to the older one and closes it; a pair you mark as not the same isn&apos;t
        suggested again.
      </p>
      {pairsQuery.isPending ? <Spinner /> : null}
      {pairsQuery.error ? <p className="text-sm text-destructive">{errorMessage(pairsQuery.error)}</p> : null}
      {pairsQuery.isSuccess && pairs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No possible duplicates on this board.
        </p>
      ) : null}
      {pairs.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
          {pairs.map(pair => (
            <PairRow key={pair.id} workspaceId={workspaceId} projectId={projectId} pair={pair} />
          ))}
        </ul>
      )}
    </section>
  );
}
