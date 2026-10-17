// The inbox's ship banner (#179): for each release run that shipped posts on the board, "N posts
// shipped in run abc1234 (approved by sre)", the posts, and Mark shipped / Dismiss. Marking them
// shipped is a status change like any other, so followers who voted by email hear about it. Reads
// and writes only through `feedback.shipSuggestions`, `acceptShipSuggestions` and `dismissShipSuggestions`.
import Link from 'next/link';

import { errorMessage } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { inferRouterOutputs } from '@trpc/server';

type ShipRun = inferRouterOutputs<AppRouter>['feedback']['shipSuggestions']['runs'][number];

interface Props {
  workspaceId: string;
  projectId: string;
  boardId: string;
}

/** How often the banner looks for new releases while the inbox is open (no realtime in v1). */
const SHIP_BANNER_REFRESH_MS = 30_000;

function RunBanner({ workspaceId, projectId, boardId, run }: Props & { run: ShipRun }) {
  const utils = trpc.useUtils();
  const refresh = async () => {
    await utils.feedback.shipSuggestions.invalidate({ workspaceId, projectId, boardId });
    await utils.feedback.posts.invalidate();
  };
  const accept = trpc.feedback.acceptShipSuggestions.useMutation({ onSuccess: refresh });
  const dismiss = trpc.feedback.dismissShipSuggestions.useMutation({ onSuccess: refresh });
  const input = { workspaceId, projectId, boardId, runId: run.runId };
  const count = run.posts.length;
  const error = accept.error ?? dismiss.error;

  return (
    <section
      aria-label={`Shipped in run ${run.commitSha.slice(0, 7)}`}
      className="flex flex-col gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
      <p className="text-sm">
        <span className="font-medium">
          {count} {count === 1 ? 'post' : 'posts'} shipped
        </span>{' '}
        in run{' '}
        <Link
          href={Routes.workspaceRun(workspaceId, run.runId)}
          className="font-mono underline-offset-2 hover:underline">
          {run.commitSha.slice(0, 7)}
        </Link>
        {run.gateNames.length === 0 ? null : <> (approved by {run.gateNames.join(', ')})</>}
      </p>
      <ul className="flex flex-col gap-1 text-sm">
        {run.posts.map(post => (
          <li key={post.suggestionId} className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">#{post.number}</span>
            <Link
              href={Routes.projectFeedbackPost(workspaceId, projectId, post.id)}
              className="underline-offset-2 hover:underline">
              {post.title}
            </Link>
            <span className="text-xs text-muted-foreground">
              {post.voteCount} {post.voteCount === 1 ? 'vote' : 'votes'}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="text-sm"
          pending={accept.isPending}
          disabled={dismiss.isPending}
          onClick={() => {
            accept.mutate(input);
          }}>
          Mark shipped
        </Button>
        <Button
          variant="ghost"
          className="text-sm"
          pending={dismiss.isPending}
          disabled={accept.isPending}
          onClick={() => {
            dismiss.mutate(input);
          }}>
          Dismiss
        </Button>
        {run.changelogEntryId === null ? null : (
          <Link
            href={Routes.projectFeedbackChangelogEntry(workspaceId, projectId, run.changelogEntryId)}
            className="text-sm underline underline-offset-2">
            Draft changelog entry
          </Link>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Marking them shipped tells the followers who voted by email. The draft stays a draft until you publish it.
      </p>
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
    </section>
  );
}

/** The board's release runs with posts waiting to be marked shipped, the newest first. */
export function ShipSuggestions({ workspaceId, projectId, boardId }: Props) {
  const query = trpc.feedback.shipSuggestions.useQuery(
    { workspaceId, projectId, boardId },
    { refetchInterval: SHIP_BANNER_REFRESH_MS },
  );
  const runs = query.data?.runs ?? [];
  if (runs.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {runs.map(run => (
        <RunBanner key={run.runId} workspaceId={workspaceId} projectId={projectId} boardId={boardId} run={run} />
      ))}
    </div>
  );
}
