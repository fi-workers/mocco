// "Convert to feedback" beside a messenger conversation (#182): the posts it already became, and
// a form that turns the request into a new post on a board (title and details pre-filled from
// what the user wrote) or adds it to one of the board's posts it may repeat. The requester votes
// for the post when they were signed in. Shown only when the workspace has the feedback product.
import { FeedbackSourceTypes } from '@mocco/common/feedback';
import { Products } from '@mocco/common/project';
import Link from 'next/link';
import { useState } from 'react';

import { errorMessage, inputClass, labelClass, Spinner } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { inferRouterOutputs } from '@trpc/server';

interface Props {
  workspaceId: string;
  projectId: string;
  conversationId: string;
}

type Preview = inferRouterOutputs<AppRouter>['feedback']['intakePreview'];
const sourceType = FeedbackSourceTypes.messengerConversation;

function ConvertForm({
  workspaceId,
  projectId,
  conversationId,
  boardId,
  preview,
  onDone,
}: Props & { boardId: string; preview: Preview; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(preview.source.suggestedTitle);
  const [body, setBody] = useState(preview.source.excerpt);
  const convert = trpc.feedback.convertSource.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.feedback.sourcePosts.invalidate(), utils.feedback.intakePreview.invalidate()]);
      onDone();
    },
  });
  const base = { workspaceId, projectId, sourceType, sourceId: conversationId };
  const linkedIds = new Set(preview.linked.map(link => link.post.id));
  const similar = preview.similar.filter(post => !linkedIds.has(post.id));
  // A conversation that became a post already isn't made into another; it can join more posts.
  const canCreate = preview.linked.length === 0;
  // eslint-disable-next-line sonarjs/null-dereference -- title is a useState<string>, never null
  const trimmed = title.trim();
  // eslint-disable-next-line sonarjs/null-dereference -- body is a useState<string>, never null
  const hasBody = body.trim() !== '';

  return (
    <div className="flex flex-col gap-3">
      {similar.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Already on the board?</span>
          <ul className="flex flex-col gap-1">
            {similar.map(post => (
              <li key={post.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-xs text-muted-foreground tabular-nums">#{post.number}</span> {post.title}
                </span>
                <Button
                  variant="outline"
                  className="h-7 shrink-0 px-2 text-xs"
                  disabled={convert.isPending}
                  onClick={() => {
                    convert.mutate({ ...base, intoPostId: post.id });
                  }}>
                  Add to #{post.number}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canCreate ? (
        <form
          aria-label="New post from this conversation"
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault();
            convert.mutate({ ...base, boardId, title: trimmed, ...(hasBody && { body }) });
          }}>
          <label className={labelClass}>
            Title
            <input
              value={title}
              maxLength={200}
              onChange={event => {
                setTitle(event.target.value);
              }}
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Details
            <textarea
              value={body}
              rows={4}
              onChange={event => {
                setBody(event.target.value);
              }}
              className={`${inputClass} h-auto`}
            />
          </label>
          <span className="flex items-center gap-2">
            <Button type="submit" className="text-sm" disabled={trimmed === ''} pending={convert.isPending}>
              Create post
            </Button>
            <Button type="button" variant="ghost" className="text-sm" onClick={onDone}>
              Cancel
            </Button>
          </span>
        </form>
      ) : (
        <span className="flex items-center gap-2">
          {similar.length === 0 ? (
            <span className="text-xs text-muted-foreground">No other post on this board looks like it.</span>
          ) : null}
          <Button type="button" variant="ghost" className="text-sm" onClick={onDone}>
            Cancel
          </Button>
        </span>
      )}
      {convert.error ? <p className="text-sm text-destructive">{errorMessage(convert.error)}</p> : null}
    </div>
  );
}

function Converter({ workspaceId, projectId, conversationId, onDone }: Props & { onDone: () => void }) {
  const boardsQuery = trpc.feedback.boards.useQuery({ workspaceId, projectId });
  const boards = boardsQuery.data?.boards ?? [];
  const [boardSlug, setBoardSlug] = useState<string | null>(null);
  const board = boards.find(entry => entry.slug === boardSlug) ?? boards[0];
  const previewQuery = trpc.feedback.intakePreview.useQuery(
    { workspaceId, projectId, boardId: board?.id ?? '', sourceType, sourceId: conversationId },
    { enabled: board !== undefined },
  );

  if (boardsQuery.isPending) {
    return <Spinner />;
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
  return (
    <div className="flex flex-col gap-3">
      {boards.length > 1 ? (
        <select
          aria-label="Board"
          className={inputClass}
          value={board.slug}
          onChange={event => {
            setBoardSlug(event.target.value);
          }}>
          {boards.map(entry => (
            <option key={entry.id} value={entry.slug}>
              {entry.name}
            </option>
          ))}
        </select>
      ) : null}
      {previewQuery.isPending ? <Spinner /> : null}
      {previewQuery.error ? <p className="text-sm text-destructive">{errorMessage(previewQuery.error)}</p> : null}
      {previewQuery.data === undefined ? null : (
        // Keyed by board: another board starts again from the request.
        <ConvertForm
          key={board.id}
          workspaceId={workspaceId}
          projectId={projectId}
          conversationId={conversationId}
          boardId={board.id}
          preview={previewQuery.data}
          onDone={onDone}
        />
      )}
    </div>
  );
}

export default function ConvertToFeedback({ workspaceId, projectId, conversationId }: Props) {
  const productsQuery = trpc.product.list.useQuery({ workspaceId });
  const hasFeedback = productsQuery.data?.products.includes(Products.feedback) ?? false;
  const linkedQuery = trpc.feedback.sourcePosts.useQuery(
    { workspaceId, projectId, sourceType, sourceId: conversationId },
    { enabled: hasFeedback },
  );
  const [isConverting, setIsConverting] = useState(false);
  if (!hasFeedback) {
    return null;
  }
  const posts = linkedQuery.data?.posts ?? [];

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Feedback</h3>
      {posts.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {posts.map(post => (
            <li key={post.id} className="text-sm">
              <Link
                href={Routes.projectFeedbackPost(workspaceId, projectId, post.mergedIntoPostId ?? post.id)}
                className="underline-offset-2 hover:underline">
                <span className="text-xs text-muted-foreground tabular-nums">#{post.number}</span> {post.title}
              </Link>{' '}
              <span className="text-xs text-muted-foreground">
                {post.voteCount} {post.voteCount === 1 ? 'vote' : 'votes'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {isConverting ? (
        <Converter
          workspaceId={workspaceId}
          projectId={projectId}
          conversationId={conversationId}
          onDone={() => {
            setIsConverting(false);
          }}
        />
      ) : (
        <Button
          variant="outline"
          className="w-fit text-sm"
          onClick={() => {
            setIsConverting(true);
          }}>
          {posts.length === 0 ? 'Convert to feedback' : 'Add to another post'}
        </Button>
      )}
    </div>
  );
}
