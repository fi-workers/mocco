// A post's public comments (#175): rendered with the page, oldest first, the team's official
// response marked. Internal notes are never among them, and no comment says who wrote it beyond
// "the team" or "you". A signed-in end user comments here; the new comment shows at once.
import { FeedbackCommentAuthorKinds, FeedbackLimits } from '@mocco/common/feedback';
import { feedbackV1CommentResultSchema } from '@mocco/common/feedback-v1';
import { useState } from 'react';

import { feedbackCall, forgetToken, useEndUserToken } from '@frontend/lib/feedback-client';
import { cn } from '@frontend/lib/utils';

import type { FeedbackPageComment } from '@mocco/backend/sites/feedback';

const dateOf = (at: string) => new Date(at).toLocaleDateString('en', { dateStyle: 'medium', timeZone: 'UTC' });

function authorOf(comment: FeedbackPageComment): string {
  if (comment.isOfficial) {
    return 'Official response';
  }
  if (comment.authorKind === FeedbackCommentAuthorKinds.staff) {
    return 'The team';
  }
  return comment.isMine ? 'You' : 'A user';
}

export default function PostComments({
  site,
  postId,
  initial,
  hasMore,
}: {
  site: string;
  postId: string;
  initial: FeedbackPageComment[];
  hasMore: boolean;
}) {
  const token = useEndUserToken(site);
  const [added, setAdded] = useState<FeedbackPageComment[]>([]);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const comments = [...initial, ...added];
  // eslint-disable-next-line sonarjs/null-dereference -- state initialized to '', never null
  const isEmpty = body.trim() === '';

  const send = async () => {
    setIsSending(true);
    setError(null);
    const result = await feedbackCall(site, `/posts/${postId}/comments`, feedbackV1CommentResultSchema, {
      method: 'POST',
      token,
      body: { body },
    });
    setIsSending(false);
    if (result.ok) {
      setAdded(previous => [...previous, result.data.comment]);
      setBody('');
      return;
    }
    if (result.isTokenRefused) {
      forgetToken(site);
    }
    setError(result.title);
  };

  return (
    <section aria-labelledby="comments" className="flex flex-col gap-4">
      <h2 id="comments" className="text-lg font-semibold tracking-tight">
        Comments
      </h2>
      {comments.length === 0 ? <p className="text-sm text-muted-foreground">No comments yet.</p> : null}
      <ol className="flex flex-col gap-3">
        {comments.map(comment => (
          <li
            key={comment.id}
            className={cn(
              'flex flex-col gap-1 rounded-xl border border-border p-4',
              comment.isOfficial && 'border-foreground',
            )}>
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className={cn('font-medium', comment.isOfficial && 'text-foreground')}>{authorOf(comment)}</span>
              <time dateTime={comment.createdAt}>{dateOf(comment.createdAt)}</time>
            </p>
            <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
          </li>
        ))}
      </ol>
      {hasMore ? <p className="text-sm text-muted-foreground">Older comments aren&apos;t shown here.</p> : null}
      {token === undefined ? null : (
        <form
          aria-label="Add a comment"
          className="flex flex-col gap-2"
          onSubmit={event => {
            event.preventDefault();
            // eslint-disable-next-line no-void -- a submit handler can't await; send() never rejects
            void send();
          }}>
          <textarea
            required
            name="comment"
            value={body}
            maxLength={FeedbackLimits.commentMax}
            aria-label="Your comment"
            placeholder="Add a comment"
            rows={3}
            onChange={event => {
              setBody(event.target.value);
            }}
            className="rounded-md border border-border bg-background px-3 py-2"
          />
          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={isSending || isEmpty}
            className="h-9 self-start rounded-md bg-foreground px-4 text-sm font-medium text-background disabled:opacity-60">
            {isSending ? 'Sending…' : 'Comment'}
          </button>
        </form>
      )}
    </section>
  );
}
