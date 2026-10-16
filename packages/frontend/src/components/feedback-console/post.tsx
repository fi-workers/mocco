// A feedback post in the console (#175): what the user asked for, and everything the team does
// with it — change its status or category, edit it, answer (plainly, as the official response, or
// as an internal note the public never sees), record a vote for a user who asked by email or on a
// call, and merge it into the post it duplicates. Reads and writes only through `feedback.*`.
import {
  FEEDBACK_EMAIL_END_USER_PREFIX,
  FeedbackCommentAuthorKinds,
  FeedbackLimits,
  FeedbackPostSorts,
  FeedbackPostStatuses,
  FeedbackStatusChangeReasons,
  FeedbackVoteStates,
} from '@mocco/common/feedback';
import Link from 'next/link';
import { useState } from 'react';

import { publicBoardUrl, useHelpSiteSlug } from '@frontend/components/feedback-console/boards';
import { statusTones } from '@frontend/components/feedback-console/inbox';
import {
  Ago,
  errorMessage,
  inputClass,
  labelClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { feedbackStatusLabels } from '@frontend/lib/feedback-client';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { AppRouter } from '@mocco/backend/trpc/root';
import type { FeedbackPostStatus, FeedbackStatusChangeReason } from '@mocco/common/feedback';
import type { inferRouterOutputs } from '@trpc/server';
import type { ReactNode } from 'react';

type Outputs = inferRouterOutputs<AppRouter>['feedback'];
type Post = Outputs['post']['post'];
type Category = Outputs['board']['categories'][number];

interface Props {
  workspaceId: string;
  projectId: string;
  postId: string;
}

/** How a comment is posted: seen by everyone, pinned as the team's answer, or kept to the team. */
const CommentKinds = { reply: 'reply', official: 'official', internal: 'internal' } as const;
type CommentKind = (typeof CommentKinds)[keyof typeof CommentKinds];
const commentKindLabels: Record<CommentKind, string> = {
  [CommentKinds.reply]: 'Reply',
  [CommentKinds.official]: 'Official response',
  [CommentKinds.internal]: 'Internal note',
};

const reasonLabels: Record<FeedbackStatusChangeReason, string> = {
  [FeedbackStatusChangeReasons.created]: 'Posted',
  [FeedbackStatusChangeReasons.manual]: 'Changed',
  [FeedbackStatusChangeReasons.shipSuggestion]: 'Suggested by a deploy',
  [FeedbackStatusChangeReasons.autoApply]: 'Shipped by a deploy',
  [FeedbackStatusChangeReasons.merge]: 'Merged',
};

/** An end user as the team sees them: an email voter's address, else the app's user id. */
export const endUserLabel = (endUserId: string) =>
  // eslint-disable-next-line sonarjs/null-dereference -- endUserId is a string, never null
  endUserId.startsWith(FEEDBACK_EMAIL_END_USER_PREFIX)
    ? endUserId.slice(FEEDBACK_EMAIL_END_USER_PREFIX.length)
    : endUserId;

/** Team members' names by user id, for comments and history. */
function useMemberNames(workspaceId: string): (userId: string | null) => string {
  const membersQuery = trpc.workspace.members.useQuery({ workspaceId });
  const names = new Map((membersQuery.data?.members ?? []).map(member => [member.user.id, member.user.name]));
  return userId => (userId === null ? 'A former member' : (names.get(userId) ?? 'A former member'));
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function EditPost({
  workspaceId,
  projectId,
  post,
  onDone,
}: Omit<Props, 'postId'> & { post: Post; onDone: () => void }) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const update = trpc.feedback.updatePost.useMutation({
    onSuccess: async () => {
      await utils.feedback.post.invalidate();
      onDone();
    },
  });
  return (
    <form
      aria-label="Edit post"
      className="flex flex-col gap-2"
      onSubmit={event => {
        event.preventDefault();
        update.mutate({ workspaceId, projectId, postId: post.id, title, body });
      }}>
      <label className={labelClass}>
        Title
        <input
          value={title}
          required
          maxLength={FeedbackLimits.titleMax}
          onChange={event => {
            setTitle(event.target.value);
          }}
          className={inputClass}
        />
      </label>
      <label className={labelClass}>
        Description (Markdown)
        <textarea
          value={body}
          rows={8}
          maxLength={FeedbackLimits.bodyMax}
          onChange={event => {
            setBody(event.target.value);
          }}
          className={`${inputClass} font-mono`}
        />
      </label>
      {update.error ? <p className="text-sm text-destructive">{errorMessage(update.error)}</p> : null}
      <span className="flex gap-2">
        <Button type="submit" className="text-sm" pending={update.isPending}>
          Save
        </Button>
        <Button variant="ghost" className="text-sm" onClick={onDone}>
          Cancel
        </Button>
      </span>
    </form>
  );
}

/** Merge this post into another on its board: pick the target from the board's posts by title. */
function MergeInto({ workspaceId, projectId, post }: Omit<Props, 'postId'> & { post: Post }) {
  const utils = trpc.useUtils();
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [targetId, setTargetId] = useState<string | null>(null);
  const candidatesQuery = trpc.feedback.posts.useQuery(
    { workspaceId, projectId, boardId: post.boardId, sort: FeedbackPostSorts.top, limit: FeedbackLimits.listMax },
    { enabled: isOpen },
  );
  const merge = trpc.feedback.mergePost.useMutation({
    onSuccess: async () => {
      setIsOpen(false);
      await utils.feedback.post.invalidate();
      await utils.feedback.posts.invalidate();
    },
  });
  // eslint-disable-next-line sonarjs/null-dereference -- search is a useState<string>, never null
  const words = search
    .toLowerCase()
    .split(/\s+/u)
    .filter(word => word !== '');
  const candidates = (candidatesQuery.data?.posts ?? []).filter(
    candidate =>
      candidate.id !== post.id &&
      candidate.mergedIntoPostId === null &&
      words.every(word => candidate.title.toLowerCase().includes(word) || String(candidate.number) === word),
  );
  const target = candidates.find(candidate => candidate.id === targetId);

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        className="w-fit text-sm"
        onClick={() => {
          setIsOpen(true);
        }}>
        Merge into another post…
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-xs text-muted-foreground">
        Its votes and followers move to the post you pick, each user counted once, and this post is closed. Its public
        address sends readers there.
      </p>
      <input
        aria-label="Search posts to merge into"
        placeholder="Search by title or number"
        value={search}
        onChange={event => {
          setSearch(event.target.value);
          setTargetId(null);
        }}
        className={inputClass}
      />
      {candidatesQuery.isPending ? <Spinner /> : null}
      <ul className="flex max-h-56 flex-col overflow-y-auto rounded-md border border-border">
        {candidates.slice(0, 20).map(candidate => (
          <li key={candidate.id}>
            <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-muted/50">
              <input
                type="radio"
                name="merge-target"
                checked={candidate.id === targetId}
                onChange={() => {
                  setTargetId(candidate.id);
                }}
              />
              <span className="text-xs text-muted-foreground tabular-nums">#{candidate.number}</span>
              <span className="flex-1 truncate">{candidate.title}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{candidate.voteCount}</span>
            </label>
          </li>
        ))}
        {candidatesQuery.isSuccess && candidates.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-muted-foreground">No other post matches.</li>
        ) : null}
      </ul>
      {merge.error ? <p className="text-sm text-destructive">{errorMessage(merge.error)}</p> : null}
      <span className="flex gap-2">
        <Button
          className="text-sm"
          disabled={target === undefined}
          pending={merge.isPending}
          onClick={() => {
            if (target !== undefined) {
              merge.mutate({ workspaceId, projectId, postId: post.id, intoPostId: target.id });
            }
          }}>
          {target === undefined ? 'Merge' : `Merge into #${String(target.number)}`}
        </Button>
        <Button
          variant="ghost"
          className="text-sm"
          onClick={() => {
            setIsOpen(false);
          }}>
          Cancel
        </Button>
      </span>
    </div>
  );
}

/** Status, category and merge: the triage controls beside the post. */
function Triage({
  workspaceId,
  projectId,
  post,
  categories,
}: Omit<Props, 'postId'> & { post: Post; categories: readonly Category[] }) {
  const utils = trpc.useUtils();
  const refresh = async () => {
    await utils.feedback.post.invalidate();
    await utils.feedback.posts.invalidate();
  };
  const statusChange = trpc.feedback.setPostStatus.useMutation({ onSuccess: refresh });
  const update = trpc.feedback.updatePost.useMutation({ onSuccess: refresh });
  const error = statusChange.error ?? update.error;

  return (
    <div className="flex flex-col gap-3">
      <label className={labelClass}>
        Status
        <select
          className={inputClass}
          value={post.status}
          disabled={statusChange.isPending || post.mergedIntoPostId !== null}
          onChange={event => {
            statusChange.mutate({
              workspaceId,
              projectId,
              postId: post.id,
              status: event.target.value as FeedbackPostStatus,
            });
          }}>
          {Object.values(FeedbackPostStatuses).map(value => (
            <option key={value} value={value}>
              {feedbackStatusLabels[value]}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Category
        <select
          className={inputClass}
          value={post.categoryId ?? ''}
          disabled={update.isPending}
          onChange={event => {
            update.mutate({
              workspaceId,
              projectId,
              postId: post.id,
              categoryId: event.target.value === '' ? null : event.target.value,
            });
          }}>
          <option value="">No category</option>
          {categories.map(category => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
      {post.mergedIntoPostId === null ? (
        <MergeInto workspaceId={workspaceId} projectId={projectId} post={post} />
      ) : null}
    </div>
  );
}

function Comments({ workspaceId, projectId, postId }: Props) {
  const utils = trpc.useUtils();
  const nameOf = useMemberNames(workspaceId);
  const commentsQuery = trpc.feedback.comments.useQuery({
    workspaceId,
    projectId,
    postId,
    limit: FeedbackLimits.listMax,
  });
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<CommentKind>(CommentKinds.reply);
  const create = trpc.feedback.createComment.useMutation({
    onSuccess: async () => {
      setBody('');
      setKind(CommentKinds.reply);
      await utils.feedback.comments.invalidate({ workspaceId, projectId, postId });
      await utils.feedback.post.invalidate();
    },
  });
  const comments = commentsQuery.data?.comments ?? [];
  // eslint-disable-next-line sonarjs/null-dereference -- body is a useState<string>, never null
  const trimmed = body.trim();

  return (
    <Section title={`Comments (${String(comments.length)})`}>
      {commentsQuery.isPending ? <Spinner /> : null}
      <ul className="flex flex-col gap-2">
        {comments.map(comment => (
          <li
            key={comment.id}
            className={`flex flex-col gap-1 rounded-lg border p-3 ${
              comment.isInternal ? 'border-amber-500/40 bg-amber-500/5' : 'border-border'
            }`}>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {comment.authorKind === FeedbackCommentAuthorKinds.staff
                  ? nameOf(comment.authorUserId)
                  : endUserLabel(comment.authorEndUserId ?? '')}
              </span>
              {comment.isOfficial ? <StatusBadge tone={Tones.ok}>Official response</StatusBadge> : null}
              {comment.isInternal ? <StatusBadge tone={Tones.warn}>Internal note</StatusBadge> : null}
              <Ago date={comment.createdAt} />
            </span>
            <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
          </li>
        ))}
      </ul>
      <form
        aria-label="Comment"
        className="flex flex-col gap-2"
        onSubmit={event => {
          event.preventDefault();
          create.mutate({
            workspaceId,
            projectId,
            postId,
            body: trimmed,
            isOfficial: kind === CommentKinds.official,
            isInternal: kind === CommentKinds.internal,
          });
        }}>
        <textarea
          aria-label="Comment text"
          value={body}
          rows={3}
          maxLength={FeedbackLimits.commentMax}
          placeholder={
            kind === CommentKinds.internal ? 'Only your team sees this.' : 'Everyone who reads the post sees this.'
          }
          onChange={event => {
            setBody(event.target.value);
          }}
          className={inputClass}
        />
        <span className="flex flex-wrap items-center gap-3">
          {Object.values(CommentKinds).map(value => (
            <label key={value} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="comment-kind"
                checked={kind === value}
                onChange={() => {
                  setKind(value);
                }}
              />
              {commentKindLabels[value]}
            </label>
          ))}
          <Button type="submit" className="ml-auto text-sm" disabled={trimmed === ''} pending={create.isPending}>
            {kind === CommentKinds.internal ? 'Add note' : 'Comment'}
          </Button>
        </span>
        {create.error ? <p className="text-sm text-destructive">{errorMessage(create.error)}</p> : null}
      </form>
    </Section>
  );
}

function Votes({
  workspaceId,
  projectId,
  postId,
  voteCount,
  isMerged,
}: Props & { voteCount: number; isMerged: boolean }) {
  const utils = trpc.useUtils();
  const votesQuery = trpc.feedback.votes.useQuery({ workspaceId, projectId, postId, limit: FeedbackLimits.listMax });
  const subscribersQuery = trpc.feedback.subscribers.useQuery({
    workspaceId,
    projectId,
    postId,
    limit: FeedbackLimits.listMax,
  });
  const [endUserId, setEndUserId] = useState('');
  const refresh = async () => {
    await utils.feedback.votes.invalidate({ workspaceId, projectId, postId });
    await utils.feedback.subscribers.invalidate({ workspaceId, projectId, postId });
    await utils.feedback.post.invalidate();
  };
  const vote = trpc.feedback.vote.useMutation({
    onSuccess: async () => {
      setEndUserId('');
      await refresh();
    },
  });
  const unvote = trpc.feedback.unvote.useMutation({ onSuccess: refresh });
  const votes = votesQuery.data?.votes ?? [];
  const subscriberCount = subscribersQuery.data?.subscribers.length ?? 0;
  // eslint-disable-next-line sonarjs/null-dereference -- endUserId is a useState<string>, never null
  const trimmed = endUserId.trim();
  const error = vote.error ?? unvote.error;

  return (
    <Section title={`Votes (${String(voteCount)})`}>
      <p className="text-xs text-muted-foreground">
        {subscriberCount} {subscriberCount === 1 ? 'person follows' : 'people follow'} this post and hear when its
        status changes. Pending votes count once their email is confirmed.
      </p>
      {isMerged ? null : (
        <form
          aria-label="Record a vote"
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault();
            vote.mutate({ workspaceId, projectId, postId, endUserId: trimmed });
          }}>
          <input
            aria-label="User id"
            placeholder="Record a vote for a user id"
            value={endUserId}
            maxLength={FeedbackLimits.endUserIdMax}
            onChange={event => {
              setEndUserId(event.target.value);
            }}
            className={inputClass}
          />
          <Button
            type="submit"
            variant="outline"
            className="w-fit text-sm"
            disabled={trimmed === ''}
            pending={vote.isPending}>
            Add vote
          </Button>
        </form>
      )}
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
      {votesQuery.isPending ? <Spinner /> : null}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {votes.map(entry => (
          <li key={entry.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span className="flex-1 truncate font-mono text-xs">{endUserLabel(entry.endUserId)}</span>
            {entry.state === FeedbackVoteStates.pending ? (
              <StatusBadge tone={Tones.neutral}>Pending</StatusBadge>
            ) : null}
            <span className="text-xs text-muted-foreground">{entry.source}</span>
            <span className="text-xs text-muted-foreground">
              <Ago date={entry.createdAt} />
            </span>
            {isMerged ? null : (
              <Button
                variant="ghost"
                className="text-xs"
                pending={unvote.isPending && unvote.variables.endUserId === entry.endUserId}
                onClick={() => {
                  unvote.mutate({ workspaceId, projectId, postId, endUserId: entry.endUserId });
                }}>
                Remove
              </Button>
            )}
          </li>
        ))}
        {votesQuery.isSuccess && votes.length === 0 ? (
          <li className="px-3 py-1.5 text-sm text-muted-foreground">No votes yet.</li>
        ) : null}
      </ul>
    </Section>
  );
}

function History({ workspaceId, history }: { workspaceId: string; history: Outputs['post']['history'] }) {
  const nameOf = useMemberNames(workspaceId);
  return (
    <Section title="History">
      <ol className="flex flex-col gap-3 text-sm">
        {history.map(change => (
          <li key={change.id} className="flex flex-col gap-0.5">
            <span>
              {change.fromStatus === null ? null : (
                <span className="text-muted-foreground">{feedbackStatusLabels[change.fromStatus]} → </span>
              )}
              {feedbackStatusLabels[change.toStatus]}
            </span>
            <span className="flex flex-wrap gap-1 text-xs text-muted-foreground">
              <span>{reasonLabels[change.reason]}</span>
              {change.actorUserId === null ? null : <span>by {nameOf(change.actorUserId)}</span>}
              <span>·</span>
              <Ago date={change.createdAt} />
            </span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** The post a duplicate was merged into, by number and title. */
function MergedTarget({ workspaceId, projectId, postId }: Props) {
  const targetQuery = trpc.feedback.post.useQuery({ workspaceId, projectId, postId });
  const target = targetQuery.data?.post;
  return (
    <Link href={Routes.projectFeedbackPost(workspaceId, projectId, postId)} className="underline underline-offset-2">
      {target === undefined ? 'another post' : `#${String(target.number)} ${target.title}`}
    </Link>
  );
}

export default function FeedbackPost({ workspaceId, projectId, postId }: Props) {
  const postQuery = trpc.feedback.post.useQuery({ workspaceId, projectId, postId });
  const boardId = postQuery.data?.post.boardId;
  const boardQuery = trpc.feedback.board.useQuery(
    { workspaceId, projectId, boardId: boardId ?? '' },
    { enabled: boardId !== undefined },
  );
  const siteSlug = useHelpSiteSlug(workspaceId, projectId);
  const [isEditing, setIsEditing] = useState(false);

  if (postQuery.isPending) {
    return <Spinner />;
  }
  if (postQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(postQuery.error)}</p>;
  }
  const { post, history } = postQuery.data;
  const board = boardQuery.data?.board;
  const categories = boardQuery.data?.categories ?? [];
  const boardUrl =
    siteSlug === null || board === undefined || !board.isPublic ? null : publicBoardUrl(siteSlug, board.slug);
  const publicUrl = boardUrl === null ? null : `${boardUrl}/${String(post.number)}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href={Routes.projectFeedback(workspaceId, projectId, board === undefined ? {} : { board: board.slug })}
          className="text-xs text-muted-foreground hover:text-foreground">
          ← {board?.name ?? 'Inbox'}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground tabular-nums">#{post.number}</span>
          <h1 className="text-lg font-semibold">{post.title}</h1>
          <StatusBadge tone={statusTones[post.status]}>{feedbackStatusLabels[post.status]}</StatusBadge>
        </div>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {post.authorEndUserId === null ? 'Posted by the team' : `Posted by ${endUserLabel(post.authorEndUserId)}`}
          </span>
          <Ago date={post.createdAt} />
          {publicUrl === null ? null : (
            <a href={publicUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Public page
            </a>
          )}
        </p>
        {post.mergedIntoPostId === null ? null : (
          <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
            Merged into <MergedTarget workspaceId={workspaceId} projectId={projectId} postId={post.mergedIntoPostId} />:
            its votes and followers moved there.
          </p>
        )}
      </div>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="flex flex-col gap-8">
          {isEditing ? (
            <EditPost
              workspaceId={workspaceId}
              projectId={projectId}
              post={post}
              onDone={() => {
                setIsEditing(false);
              }}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {post.body === '' ? (
                <p className="text-sm text-muted-foreground">No description.</p>
              ) : (
                <p className="text-sm whitespace-pre-wrap">{post.body}</p>
              )}
              <Button
                variant="ghost"
                className="w-fit text-sm"
                onClick={() => {
                  setIsEditing(true);
                }}>
                Edit
              </Button>
            </div>
          )}
          <Comments workspaceId={workspaceId} projectId={projectId} postId={postId} />
        </div>
        <div className="flex flex-col gap-8">
          <Triage workspaceId={workspaceId} projectId={projectId} post={post} categories={categories} />
          <Votes
            workspaceId={workspaceId}
            projectId={projectId}
            postId={postId}
            voteCount={post.voteCount}
            isMerged={post.mergedIntoPostId !== null}
          />
          <History workspaceId={workspaceId} history={history} />
        </div>
      </div>
    </div>
  );
}
