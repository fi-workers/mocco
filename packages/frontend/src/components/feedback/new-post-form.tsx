// Posting an idea on a public board (#175). Only the app's signed-in end users post (their token
// came with the link from the app); everyone else is told so. While the title is typed, the
// board's similar posts show, so a visitor can vote on one instead of posting a duplicate. A new
// post starts under review with its author's vote, and the page opens it.
import { FeedbackLimits } from '@mocco/common/feedback';
import { feedbackV1PostResultSchema, feedbackV1SimilarSchema } from '@mocco/common/feedback-v1';
import { useEffect, useState } from 'react';

import { postPath } from '@frontend/components/feedback/feedback-site-layout';
import { feedbackCall, forgetToken, useEndUserToken } from '@frontend/lib/feedback-client';

import type { FeedbackPageBoard } from '@mocco/backend/sites/feedback';
import type { FeedbackV1Post } from '@mocco/common/feedback-v1';

/** Wait this long after the last keystroke before searching. */
const SIMILAR_DEBOUNCE_MS = 400;
/** Search once the title has this many characters. */
const MIN_SIMILAR_QUERY = 3;

/** The board's posts most like `query`, or undefined when the search failed. */
async function similarPosts(site: string, board: string, query: string): Promise<FeedbackV1Post[] | undefined> {
  const result = await feedbackCall(
    site,
    `/boards/${board}/similar?${new URLSearchParams({ q: query }).toString()}`,
    feedbackV1SimilarSchema,
  );
  return result.ok ? result.data.posts : undefined;
}

export default function NewPostForm({ site, board }: { site: string; board: FeedbackPageBoard }) {
  const token = useEndUserToken(site);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [similar, setSimilar] = useState<FeedbackV1Post[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  // eslint-disable-next-line sonarjs/null-dereference -- state initialized to '', never null
  const query = title.trim();
  // eslint-disable-next-line sonarjs/null-dereference -- a trimmed string, never null
  const isSearchable = query.length >= MIN_SIMILAR_QUERY;

  useEffect(() => {
    let isCurrent = true;
    const timer = setTimeout(() => {
      if (!isSearchable) {
        return;
      }
      // eslint-disable-next-line no-void -- a timer can't await; similarPosts() never rejects
      void similarPosts(site, board.slug, query).then(posts => {
        if (isCurrent && posts !== undefined) {
          setSimilar(posts);
        }
      });
    }, SIMILAR_DEBOUNCE_MS);
    return () => {
      isCurrent = false;
      clearTimeout(timer);
    };
  }, [site, board.slug, query, isSearchable]);

  if (token === undefined) {
    return (
      <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
        To post an idea, open this board from the app while you&apos;re signed in. You can vote on any post by email.
      </p>
    );
  }

  // eslint-disable-next-line sonarjs/null-dereference -- state initialized to '', never null
  const hasBody = body.trim() !== '';
  const submit = async () => {
    setIsSending(true);
    setError(null);
    const result = await feedbackCall(site, `/boards/${board.slug}/posts`, feedbackV1PostResultSchema, {
      method: 'POST',
      token,
      body: {
        title,
        source: 'web',
        ...(hasBody && { body }),
        ...(categoryId !== '' && { categoryId }),
      },
    });
    setIsSending(false);
    if (result.ok) {
      // A full load: the new post's page is rendered on its first request (ISR).
      // eslint-disable-next-line unicorn/no-unnecessary-global-this -- the bare `location` is a restricted global
      globalThis.location.assign(postPath(board.slug, result.data.post.number));
      return;
    }
    if (result.isTokenRefused) {
      forgetToken(site);
    }
    setError(result.title);
  };

  const shownSimilar = isSearchable ? similar : [];
  return (
    <form
      aria-label="Post an idea"
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
      onSubmit={event => {
        event.preventDefault();
        // eslint-disable-next-line no-void -- a submit handler can't await; submit() never rejects
        void submit();
      }}>
      <h2 className="font-medium">Post an idea</h2>
      <input
        required
        name="title"
        value={title}
        maxLength={FeedbackLimits.titleMax}
        aria-label="Title"
        placeholder="A short title for your idea"
        onChange={event => {
          setTitle(event.target.value);
        }}
        className="h-10 rounded-md border border-border bg-background px-3"
      />
      {shownSimilar.length === 0 ? null : (
        <div className="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-sm">
          <p className="font-medium">Similar posts exist. Vote on one instead?</p>
          <ul className="flex flex-col gap-0.5">
            {shownSimilar.map(post => (
              <li key={post.id}>
                <a href={postPath(board.slug, post.number)} className="underline-offset-2 hover:underline">
                  {post.title}
                </a>{' '}
                <span className="text-muted-foreground">({post.voteCount})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <textarea
        name="body"
        value={body}
        maxLength={FeedbackLimits.bodyMax}
        aria-label="Details"
        placeholder="What would it help you do? (optional)"
        rows={4}
        onChange={event => {
          setBody(event.target.value);
        }}
        className="rounded-md border border-border bg-background px-3 py-2"
      />
      {board.categories.length === 0 ? null : (
        <select
          name="category"
          value={categoryId}
          aria-label="Category"
          onChange={event => {
            setCategoryId(event.target.value);
          }}
          className="h-10 rounded-md border border-border bg-background px-3">
          <option value="">No category</option>
          {board.categories.map(category => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      )}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={isSending || query === ''}
        className="h-10 self-start rounded-md bg-foreground px-4 text-sm font-medium text-background disabled:opacity-60">
        {isSending ? 'Posting…' : 'Post'}
      </button>
    </form>
  );
}
