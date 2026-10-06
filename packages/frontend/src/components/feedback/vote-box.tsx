// A post's votes on its public page (#175). The page is rendered with the count it had then; the
// browser reads the live count, and the viewer's own vote when the app signed them in. A signed-in
// end user votes and takes the vote back at once. Anyone else votes by email: the vote waits,
// uncounted, until they open the link mailed to them.
import {
  FEEDBACK_EMAIL_MAX,
  feedbackV1IdentifyEmailResultSchema,
  feedbackV1PostDetailSchema,
  feedbackV1VoteResultSchema,
} from '@mocco/common/feedback-v1';
import { useEffect, useState } from 'react';

import { feedbackCall, forgetToken, useEndUserToken } from '@frontend/lib/feedback-client';
import { cn } from '@frontend/lib/utils';

import type { FeedbackVoteState } from '@mocco/common/feedback';

export default function VoteBox({
  site,
  postId,
  initialCount,
}: {
  site: string;
  postId: string;
  initialCount: number;
}) {
  const token = useEndUserToken(site);
  const [live, setLive] = useState<{ count: number; vote: FeedbackVoteState | null } | null>(null);
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    const load = async () => {
      const result = await feedbackCall(site, `/posts/${postId}`, feedbackV1PostDetailSchema, { token });
      if (!isCurrent) {
        return;
      }
      if (result.ok) {
        setLive({ count: result.data.post.voteCount, vote: result.data.viewer?.vote ?? null });
      } else if (result.isTokenRefused) {
        forgetToken(site);
      }
    };
    // eslint-disable-next-line no-void -- an effect can't await; load() never rejects
    void load();
    return () => {
      isCurrent = false;
    };
  }, [site, postId, token]);

  const count = live?.count ?? initialCount;
  const hasVoted = live?.vote !== null && live?.vote !== undefined;

  const toggle = async () => {
    setIsSending(true);
    setNotice(null);
    const result = await feedbackCall(site, `/posts/${postId}/vote`, feedbackV1VoteResultSchema, {
      method: hasVoted ? 'DELETE' : 'POST',
      token,
      ...(!hasVoted && { body: { source: 'web' } }),
    });
    setIsSending(false);
    if (result.ok) {
      setLive({ count: result.data.voteCount, vote: result.data.vote });
      return;
    }
    if (result.isTokenRefused) {
      forgetToken(site);
    }
    setNotice({ kind: 'error', text: result.title });
  };

  const voteByEmail = async () => {
    setIsSending(true);
    setNotice(null);
    const result = await feedbackCall(site, '/identify/email', feedbackV1IdentifyEmailResultSchema, {
      method: 'POST',
      body: { email, postId, source: 'web' },
    });
    setIsSending(false);
    setNotice(
      result.ok
        ? { kind: 'ok', text: `Check ${email}: your vote counts once you open the link we sent.` }
        : { kind: 'error', text: result.title },
    );
  };

  return (
    <section aria-label="Votes" className="flex flex-col gap-3 rounded-xl border border-border p-4">
      <div className="flex items-center gap-4">
        <p className="flex flex-col items-center">
          <output aria-live="polite" className="text-2xl leading-tight font-semibold tabular-nums">
            {count}
          </output>
          <span className="text-xs text-muted-foreground">{count === 1 ? 'vote' : 'votes'}</span>
        </p>
        {token === undefined ? null : (
          <button
            type="button"
            aria-pressed={hasVoted}
            disabled={isSending || live === null}
            onClick={() => {
              // eslint-disable-next-line no-void -- a click handler can't await; toggle() never rejects
              void toggle();
            }}
            className={cn(
              'h-10 rounded-md border border-border px-4 text-sm font-medium hover:bg-muted disabled:opacity-60',
              hasVoted && 'border-foreground bg-foreground text-background hover:bg-foreground/90',
            )}>
            {hasVoted ? 'Voted' : 'Vote'}
          </button>
        )}
      </div>
      {token === undefined ? (
        <form
          aria-label="Vote by email"
          className="flex flex-wrap items-center gap-2"
          onSubmit={event => {
            event.preventDefault();
            // eslint-disable-next-line no-void -- a submit handler can't await; voteByEmail() never rejects
            void voteByEmail();
          }}>
          <input
            required
            type="email"
            name="email"
            value={email}
            maxLength={FEEDBACK_EMAIL_MAX}
            aria-label="Your email"
            placeholder="you@example.com"
            onChange={event => {
              setEmail(event.target.value);
            }}
            className="h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3"
          />
          <button
            type="submit"
            disabled={isSending}
            className="h-10 rounded-md bg-foreground px-4 text-sm font-medium text-background disabled:opacity-60">
            Vote by email
          </button>
        </form>
      ) : null}
      {notice === null ? null : (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={cn('text-sm', notice.kind === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
          {notice.text}
        </p>
      )}
    </section>
  );
}
