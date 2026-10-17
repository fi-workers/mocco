// A project's feedback boards and their changelog for apps (#177): read a board's posts, vote
// as the app's signed-in user, and keep a "what's new" badge over the changelog, over the
// /v1/feedback routes. Reads take a key with feedback:read; votes and the changelog's "seen"
// mark take feedback:write and the end user's token (an HS256 JWT the app's server signs with
// the project's identity secret), sent as `Authorization: Bearer …` with the key in
// `X-Mocco-Key`. The wire types are written out here (no schema library in the bundle); the
// backend's contract test checks them against the routes' schemas.
//
// A subpath of its own (`@mocco/sdk-core/feedback`), so the core browser bundle doesn't carry
// it; the "what's new" badge state over it is `@mocco/sdk-core/whats-new`. It imports the package's main entry rather than its files, so the built subpath shares
// that entry's `MoccoClient` and `MoccoError` instead of copies.
import { keyKindOf, MoccoClient, MoccoError, MoccoKeyError } from '@mocco/sdk-core';

import type { RequestOptions } from '@mocco/sdk-core';

export type FeedbackPostStatus = 'under_review' | 'planned' | 'in_progress' | 'shipped' | 'closed';
export type FeedbackVoteState = 'pending' | 'counted';
export type FeedbackChangelogTag = 'new' | 'improved' | 'fixed';

export interface FeedbackCategory {
  id: string;
  slug: string;
  name: string;
}

/** What `GET /v1/feedback/boards/:slug` answers (inside `board`). */
export interface FeedbackBoard {
  slug: string;
  name: string;
  categories: FeedbackCategory[];
}

/** A post as the public sees it. `mergedIntoPostId` is set on a duplicate: show that post instead. */
export interface FeedbackPost {
  id: string;
  number: number;
  title: string;
  body: string;
  status: FeedbackPostStatus;
  categoryId: string | null;
  voteCount: number;
  commentCount: number;
  createdAt: string;
  shippedAt: string | null;
  mergedIntoPostId: string | null;
}

export interface FeedbackPostPage {
  posts: FeedbackPost[];
  /** The offset of the next page, or null on the last. */
  nextOffset: number | null;
}

/** One post; `viewer` is the signed-in end user's own vote (null without an end user). */
export interface FeedbackPostDetail {
  post: FeedbackPost;
  viewer: { vote: FeedbackVoteState | null } | null;
}

export interface FeedbackVoteResult {
  vote: FeedbackVoteState | null;
  voteCount: number;
}

/** A post a changelog entry announces. */
export interface FeedbackChangelogPost {
  id: string;
  number: number;
  title: string;
  status: FeedbackPostStatus;
}

/** A published changelog entry. */
export interface FeedbackChangelogEntry {
  id: string;
  slug: string;
  title: string;
  /** Markdown; render it without raw HTML. */
  body: string;
  tags: FeedbackChangelogTag[];
  publishedAt: string;
  posts: FeedbackChangelogPost[];
}

export interface FeedbackChangelogPage {
  entries: FeedbackChangelogEntry[];
  nextOffset: number | null;
}

/** How many entries were published since the end user (or this device) last looked, up to 100. */
export interface FeedbackChangelogUnread {
  count: number;
  lastSeenAt: string | null;
}

export interface FeedbackChangelogSeen {
  lastSeenAt: string;
}

/** The board's roadmap: its public posts in each roadmap column. */
export interface FeedbackRoadmap {
  planned: FeedbackPost[];
  in_progress: FeedbackPost[];
  shipped: FeedbackPost[];
}

/**
 * A comment as the public sees it: the team's (`authorKind: 'staff'`, `isOfficial` for an
 * official answer) or an end user's, never who wrote it; `isMine` marks the viewer's own.
 */
export interface FeedbackComment {
  id: string;
  authorKind: 'staff' | 'end_user';
  isOfficial: boolean;
  isMine: boolean;
  body: string;
  createdAt: string;
}

export interface FeedbackCommentPage {
  comments: FeedbackComment[];
  nextOffset: number | null;
}

/** A new post from the signed-in end user. It starts under review, with their vote. */
export interface FeedbackPostCreateRequest {
  /** 1–200 characters. */
  title: string;
  /** Up to 20,000 characters. */
  body?: string;
  /** One of the board's categories (`FeedbackBoard.categories[].id`). */
  categoryId?: string;
}

/** Whether the signed-in end user follows a post. */
export interface FeedbackSubscription {
  subscribed: boolean;
}

export interface FeedbackPageOptions {
  /** 1–100 (default 20). */
  limit?: number;
  offset?: number;
}

export interface FeedbackPostListOptions extends FeedbackPageOptions {
  status?: FeedbackPostStatus;
  /** A category's slug. */
  category?: string;
  /** `top` (default): most votes first. `new`: newest first. */
  sort?: 'top' | 'new';
}

/** The signed-in end user's token from the app's server, or null while nobody is signed in. */
export type EndUserTokenSource = () => Promise<string | null> | string | null;

export interface FeedbackClientOptions {
  /** A publishable key (`mk_pub_…`) with feedback:read, and feedback:write to vote or mark seen. */
  publishableKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * The signed-in end user's token: an HS256 JWT your server signs with the project's identity
   * secret (`sub` = the user's id, expiring within an hour). Called when the client first needs
   * one, and again when Mocco refuses the one it has (expired); `resetEndUser()` forgets it.
   * Without it (or while it returns null) the client reads as an anonymous visitor.
   */
  endUserToken?: EndUserTokenSource;
}

const FEEDBACK_PATH = '/feedback';
const ProblemCodes = {
  missing: 'missing_end_user_token',
  invalid: 'invalid_end_user_token',
} as const;

/** Whether the request names the end user: never, when there is one, or always (a write). */
type EndUserUse = 'none' | 'optional' | 'required';

function queryOf(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  // eslint-disable-next-line no-restricted-syntax -- a plain loop over a handful of params
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(name, String(value));
    }
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/** One board's reads and its changelog, from `FeedbackClient.board(slug)`. */
export interface FeedbackBoardClient {
  readonly slug: string;
  /** The board's name and categories. A private or missing board is a 404 `MoccoError`. */
  get(): Promise<FeedbackBoard>;
  /** The board's posts (merged duplicates left out), most voted first unless `sort: 'new'`. */
  posts(opts?: FeedbackPostListOptions): Promise<FeedbackPostPage>;
  /** The board's public posts by roadmap column: planned, in progress and shipped. */
  roadmap(): Promise<FeedbackRoadmap>;
  /**
   * Posts like `title`, e.g. while the end user types an idea, so they can vote for one
   * instead of posting a duplicate. Up to `limit` (1–10, default 5).
   */
  similar(title: string, opts?: { limit?: number }): Promise<FeedbackPost[]>;
  /** Post an idea as the signed-in end user (needs feedback:write); it counts their vote. */
  createPost(input: FeedbackPostCreateRequest): Promise<FeedbackPost>;
  /** Published changelog entries, newest first. */
  changelog(opts?: FeedbackPageOptions): Promise<FeedbackChangelogPage>;
  /**
   * Entries published since the signed-in end user last marked the changelog seen; for an
   * anonymous visitor (or before their first mark), since `since`, which the app keeps on the
   * device; else every entry. Counted up to 100.
   */
  changelogUnread(opts?: { since?: string }): Promise<FeedbackChangelogUnread>;
  /** The signed-in end user has read the changelog up to now (needs feedback:write). */
  markChangelogSeen(): Promise<FeedbackChangelogSeen>;
}

/**
 * The /v1/feedback client. One per app (it caches the end user's token); `board(slug)` reads
 * and writes one board.
 */
export class FeedbackClient {
  private readonly client: MoccoClient;

  private token: Promise<string | null> | undefined;

  constructor(private readonly options: FeedbackClientOptions) {
    if (keyKindOf(options.publishableKey) !== 'publishable') {
      throw new MoccoKeyError('Feedback uses a publishable key (mk_pub_…) with feedback:read');
    }
    this.client = new MoccoClient({
      key: options.publishableKey,
      ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    });
  }

  /** Forget the end user's token, e.g. after they sign out or another user signs in. */
  resetEndUser(): void {
    this.token = undefined;
  }

  /** The end user's token, asked for once and kept; null without an end user. */
  async endUserToken(): Promise<string | null> {
    const source = this.options.endUserToken;
    if (source === undefined) {
      return null;
    }
    this.token ??= (async () => await source())();
    try {
      return await this.token;
    } catch (error) {
      this.token = undefined;
      throw error;
    }
  }

  /** A /v1/feedback request, with the end user's token as `use` asks for it. */
  async request<T>(method: string, path: string, use: EndUserUse, body?: unknown, isRetry = false): Promise<T> {
    const token = use === 'none' ? null : await this.endUserToken();
    if (token === null && use === 'required') {
      throw new MoccoError(401, {
        type: ProblemCodes.missing,
        title: "An end-user token from the app's server is required",
      });
    }
    const opts: RequestOptions = {
      ...(body !== undefined && { body }),
      ...(token !== null && {
        headers: { authorization: `Bearer ${token}`, 'x-mocco-key': this.options.publishableKey },
      }),
    };
    try {
      return await this.client.request<T>(method, `${FEEDBACK_PATH}${path}`, opts);
    } catch (error) {
      // An expired token: ask the app's server for a fresh one, once.
      if (!isRetry && token !== null && error instanceof MoccoError && error.code === ProblemCodes.invalid) {
        this.resetEndUser();
        return await this.request<T>(method, path, use, body, true);
      }
      throw error;
    }
  }

  /** One board's posts, changelog and "what's new" count. */
  board(slug: string): FeedbackBoardClient {
    const path = `/boards/${encodeURIComponent(slug)}`;
    return {
      slug,
      get: async () => {
        const answer = await this.request<{ board: FeedbackBoard }>('GET', path, 'none');
        return answer.board;
      },
      posts: async (opts = {}) => {
        const { status, category, sort, limit, offset } = opts;
        return await this.request<FeedbackPostPage>(
          'GET',
          `${path}/posts${queryOf({ status, category, sort, limit, offset })}`,
          'none',
        );
      },
      roadmap: async () => {
        const answer = await this.request<{ roadmap: FeedbackRoadmap }>('GET', `${path}/roadmap`, 'none');
        return answer.roadmap;
      },
      similar: async (title, opts = {}) => {
        const answer = await this.request<{ posts: FeedbackPost[] }>(
          'GET',
          `${path}/similar${queryOf({ q: title, limit: opts.limit })}`,
          'none',
        );
        return answer.posts;
      },
      createPost: async input => {
        const answer = await this.request<{ post: FeedbackPost }>('POST', `${path}/posts`, 'required', input);
        return answer.post;
      },
      changelog: async (opts = {}) =>
        await this.request<FeedbackChangelogPage>(
          'GET',
          `${path}/changelog${queryOf({ limit: opts.limit, offset: opts.offset })}`,
          'none',
        ),
      changelogUnread: async (opts = {}) =>
        await this.request<FeedbackChangelogUnread>(
          'GET',
          `${path}/changelog/unread${queryOf({ since: opts.since })}`,
          'optional',
        ),
      markChangelogSeen: async () =>
        await this.request<FeedbackChangelogSeen>('POST', `${path}/changelog/seen`, 'required'),
    };
  }

  /** One post, with the signed-in end user's own vote in `viewer`. */
  async post(postId: string): Promise<FeedbackPostDetail> {
    return await this.request<FeedbackPostDetail>('GET', `/posts/${encodeURIComponent(postId)}`, 'optional');
  }

  /** Vote for a post as the signed-in end user; voting again changes nothing. */
  async vote(postId: string): Promise<FeedbackVoteResult> {
    return await this.request<FeedbackVoteResult>('POST', `/posts/${encodeURIComponent(postId)}/vote`, 'required');
  }

  /** A post's public comments, oldest first; signed in, `isMine` marks the end user's own. */
  async comments(postId: string, opts: FeedbackPageOptions = {}): Promise<FeedbackCommentPage> {
    return await this.request<FeedbackCommentPage>(
      'GET',
      `/posts/${encodeURIComponent(postId)}/comments${queryOf({ limit: opts.limit, offset: opts.offset })}`,
      'optional',
    );
  }

  /** Comment on a post as the signed-in end user (1–8,000 characters). */
  async comment(postId: string, body: string): Promise<FeedbackComment> {
    const answer = await this.request<{ comment: FeedbackComment }>(
      'POST',
      `/posts/${encodeURIComponent(postId)}/comments`,
      'required',
      { body },
    );
    return answer.comment;
  }

  /**
   * Follow a post as the signed-in end user, to hear when it moves. Voting follows a post
   * already; `unfollow` opts out, and a later vote doesn't follow it again.
   */
  async follow(postId: string): Promise<FeedbackSubscription> {
    return await this.request<FeedbackSubscription>(
      'POST',
      `/posts/${encodeURIComponent(postId)}/subscription`,
      'required',
    );
  }

  /** Stop following a post. */
  async unfollow(postId: string): Promise<FeedbackSubscription> {
    return await this.request<FeedbackSubscription>(
      'DELETE',
      `/posts/${encodeURIComponent(postId)}/subscription`,
      'required',
    );
  }

  /** Take the signed-in end user's vote back. */
  async unvote(postId: string): Promise<FeedbackVoteResult> {
    return await this.request<FeedbackVoteResult>('DELETE', `/posts/${encodeURIComponent(postId)}/vote`, 'required');
  }
}
