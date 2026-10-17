// The public side of a project's feedback boards (#174): what /v1/feedback serves to an app,
// a widget or a public board page, and what the app's signed-in end users do there. Every
// answer is an explicit projection: a private board, its posts and their comments read as
// not found; internal notes, the team's ids and other end users' ids are never in it. Writes
// go through VoteService, CommentService, SubscriptionService and PostService, so their locks
// and counters hold here too.
import { FeedbackCommentAuthorKinds, FeedbackVoteStates, RoadmapColumns } from '@mocco/common/feedback';
import { FeedbackPublicSorts } from '@mocco/common/feedback-v1';

import {
  ChangelogEntryNotFoundError,
  FeedbackBoardNotFoundError,
  FeedbackCategoryNotFoundError,
  FeedbackPostNotFoundError,
} from '@backend/domain/feedback/errors';
import { FeedbackBoardRepo } from '@backend/domain/feedback/repos/board.repo';
import { FeedbackCategoryRepo } from '@backend/domain/feedback/repos/category.repo';
import { ChangelogEntryRepo } from '@backend/domain/feedback/repos/changelog-entry.repo';
import { ChangelogReadRepo } from '@backend/domain/feedback/repos/changelog-read.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { FeedbackVoteRepo } from '@backend/domain/feedback/repos/vote.repo';

import type { CommentService, FeedbackPublicComment } from '@backend/domain/feedback/CommentService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackBoardRow } from '@backend/domain/feedback/repos/board.repo';
import type { ChangelogEntryRow } from '@backend/domain/feedback/repos/changelog-entry.repo';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { SubscriptionService } from '@backend/domain/feedback/SubscriptionService';
import type { VoteService } from '@backend/domain/feedback/VoteService';
import type { Db } from '@backend/infra/db/types';
import type {
  ChangelogTag,
  FeedbackPage,
  FeedbackPostStatus,
  FeedbackVoteSources,
  FeedbackVoteState,
  RoadmapColumn,
} from '@mocco/common/feedback';
import type { FeedbackPublicSort } from '@mocco/common/feedback-v1';

export interface PublicBoardServiceDeps {
  db: Db;
  votes: Pick<VoteService, 'vote' | 'unvote'>;
  comments: Pick<CommentService, 'createAsEndUser' | 'listForPublic'>;
  posts: Pick<PostService, 'createAsEndUser'>;
  subscriptions: Pick<SubscriptionService, 'subscribe' | 'unsubscribe'>;
  now?: () => Date;
}

/** The end-user sources a /v1 caller may name. */
export type PublicVoteSource = typeof FeedbackVoteSources.web | typeof FeedbackVoteSources.widget;

/** The words `similar` matches on: letters and digits, two characters or more, at most eight. */
export const SIMILAR_MAX_WORDS = 8;
const wordsOf = (query: string): string[] => [
  // eslint-disable-next-line sonarjs/null-dereference -- query is a parsed string, never null
  ...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, SIMILAR_MAX_WORDS)),
];

/** How many posts each roadmap column shows (the most voted). */
export const ROADMAP_COLUMN_LIMIT = 50;

/** How many posts a project's sitemap lists at most (the most recently changed). */
export const SITEMAP_POST_LIMIT = 10_000;

/** How many changelog entries a project's sitemap lists at most (the newest). */
export const SITEMAP_CHANGELOG_LIMIT = 1000;

/** The unread badge counts up to this many entries (a widget shows "99+"). */
export const CHANGELOG_UNREAD_CAP = 100;

/** How many changelog entries a post page lists as having shipped it (the newest). */
export const POST_CHANGELOG_LIMIT = 10;

/** A published changelog entry as the public sees it: no author, no draft state. */
export interface PublicChangelogEntry {
  id: string;
  slug: string;
  title: string;
  body: string;
  tags: ChangelogTag[];
  publishedAt: Date;
  posts: { id: string; number: number; title: string; status: FeedbackPostStatus }[];
}

/** A post as the public sees it. */
export interface PublicPost {
  id: string;
  number: number;
  title: string;
  body: string;
  status: FeedbackPostStatus;
  categoryId: string | null;
  voteCount: number;
  commentCount: number;
  createdAt: Date;
  shippedAt: Date | null;
  /** Set on a duplicate: the post its votes moved to. */
  mergedIntoPostId: string | null;
}

/** A listed post; with a viewer, `viewerVote` is their own vote on it (null when none). */
export type PublicListedPost = PublicPost & { viewerVote?: FeedbackVoteState | null };

/** A comment as the public sees it: `isMine` instead of anyone's id. */
export interface PublicComment {
  id: string;
  authorKind: FeedbackPublicComment['authorKind'];
  isOfficial: boolean;
  isMine: boolean;
  body: string;
  createdAt: Date;
}

export interface PublicPage<T> {
  items: T[];
  nextOffset: number | null;
}

export const toPublicPost = (row: FeedbackPostRow): PublicPost => ({
  id: row.id,
  number: row.number,
  title: row.title,
  body: row.body,
  status: row.status,
  categoryId: row.categoryId,
  voteCount: row.voteCount,
  commentCount: row.commentCount,
  createdAt: row.createdAt,
  shippedAt: row.shippedAt,
  mergedIntoPostId: row.mergedIntoPostId,
});

const toPublicComment = (comment: FeedbackPublicComment, viewer: string | undefined): PublicComment => ({
  id: comment.id,
  authorKind: comment.authorKind,
  isOfficial: comment.isOfficial,
  isMine:
    viewer !== undefined &&
    comment.authorKind === FeedbackCommentAuthorKinds.endUser &&
    comment.authorEndUserId === viewer,
  body: comment.body,
  createdAt: comment.createdAt,
});

/** A page of `limit` from `limit + 1` rows: the extra row says there is more. */
const pageOf = <T>(rows: T[], page: FeedbackPage): PublicPage<T> => ({
  items: rows.slice(0, page.limit),
  nextOffset: rows.length > page.limit ? page.offset + page.limit : null,
});

export class PublicBoardService {
  constructor(private readonly deps: PublicBoardServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The public board with the slug; a private or missing one is FeedbackBoardNotFoundError. */
  private async publicBoard(scope: FeedbackScope, slug: string): Promise<FeedbackBoardRow> {
    const board = await new FeedbackBoardRepo(this.deps.db).findBySlug(scope, slug);
    if (board?.isPublic !== true) {
      throw new FeedbackBoardNotFoundError(slug);
    }
    return board;
  }

  /** The post, on a public board; anything else is FeedbackPostNotFoundError. */
  private async publicPost(scope: FeedbackScope, postId: string): Promise<FeedbackPostRow> {
    const post = await new FeedbackPostRepo(this.deps.db).find(scope, postId);
    const board = post === undefined ? undefined : await new FeedbackBoardRepo(this.deps.db).find(scope, post.boardId);
    if (post === undefined || board?.isPublic !== true) {
      throw new FeedbackPostNotFoundError(postId);
    }
    return post;
  }

  /** `posts` with the viewer's own vote on each, from one query; unchanged without a viewer. */
  private async withViewerVotes(
    scope: FeedbackScope,
    posts: PublicPost[],
    viewer: string | undefined,
  ): Promise<PublicListedPost[]> {
    if (viewer === undefined) {
      return posts;
    }
    const states = await new FeedbackVoteRepo(this.deps.db).statesFor(
      scope.workspaceId,
      viewer,
      posts.map(post => post.id),
    );
    return posts.map(post => ({ ...post, viewerVote: states.get(post.id) ?? null }));
  }

  /** Published entries with the posts they announce. */
  private async publicEntries(rows: readonly ChangelogEntryRow[]): Promise<PublicChangelogEntry[]> {
    const posts = await new ChangelogEntryRepo(this.deps.db).postsOf(rows.map(row => row.id));
    return rows.map(row => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      body: row.bodyMd,
      tags: row.tags,
      publishedAt: row.publishedAt ?? row.updatedAt,
      posts: posts.get(row.id) ?? [],
    }));
  }

  /** The board and its categories in order. */
  async board(scope: FeedbackScope, slug: string) {
    const board = await this.publicBoard(scope, slug);
    const categories = await new FeedbackCategoryRepo(this.deps.db).listForBoard(scope, board.id);
    return {
      slug: board.slug,
      name: board.name,
      categories: categories.map(category => ({ id: category.id, slug: category.slug, name: category.name })),
    };
  }

  /** The board's posts, merged duplicates left out, filtered by status and category slug; with a
   * viewer, each with their own vote. */
  async posts(
    scope: FeedbackScope,
    slug: string,
    query: { status?: FeedbackPostStatus; category?: string; sort: FeedbackPublicSort } & FeedbackPage,
    viewer?: string,
  ): Promise<PublicPage<PublicListedPost>> {
    const board = await this.publicBoard(scope, slug);
    let categoryId: string | undefined;
    if (query.category !== undefined) {
      const categories = await new FeedbackCategoryRepo(this.deps.db).listForBoard(scope, board.id);
      categoryId = categories.find(category => category.slug === query.category)?.id;
      if (categoryId === undefined) {
        throw new FeedbackCategoryNotFoundError(query.category);
      }
    }
    const rows = await new FeedbackPostRepo(this.deps.db).listPublic(scope, {
      boardId: board.id,
      ...(query.status !== undefined && { statuses: [query.status] }),
      ...(categoryId !== undefined && { categoryId }),
      sort: query.sort,
      limit: query.limit + 1,
      offset: query.offset,
    });
    const page = pageOf(
      rows.map(row => toPublicPost(row)),
      query,
    );
    return { ...page, items: await this.withViewerVotes(scope, page.items, viewer) };
  }

  /** The board's roadmap: the most voted posts of each column; with a viewer, each with their own
   * vote (one query for every column). */
  async roadmap(
    scope: FeedbackScope,
    slug: string,
    viewer?: string,
  ): Promise<Record<RoadmapColumn, PublicListedPost[]>> {
    const board = await this.publicBoard(scope, slug);
    const posts = new FeedbackPostRepo(this.deps.db);
    const columns = await Promise.all(
      RoadmapColumns.map(async column => {
        const rows = await posts.listPublic(scope, {
          boardId: board.id,
          statuses: [column],
          sort: FeedbackPublicSorts.top,
          limit: ROADMAP_COLUMN_LIMIT,
          offset: 0,
        });
        return [column, rows.map(row => toPublicPost(row))] as const;
      }),
    );
    const listed = await this.withViewerVotes(
      scope,
      columns.flatMap(([, rows]) => rows),
      viewer,
    );
    const byId = new Map(listed.map(post => [post.id, post]));
    return Object.fromEntries(
      columns.map(([column, rows]) => [column, rows.map(post => byId.get(post.id) ?? post)]),
    ) as Record<RoadmapColumn, PublicListedPost[]>;
  }

  /** One post; with a viewer, also their vote on it. A merged duplicate is served with
   * `mergedIntoPostId`, so the caller can show the post it was merged into. */
  async post(
    scope: FeedbackScope,
    postId: string,
    viewer?: string,
  ): Promise<{ post: PublicPost; viewer: { vote: FeedbackVoteState | null } | null }> {
    const post = await this.publicPost(scope, postId);
    if (viewer === undefined) {
      return { post: toPublicPost(post), viewer: null };
    }
    const vote = await new FeedbackVoteRepo(this.deps.db).find(scope.workspaceId, postId, viewer);
    return { post: toPublicPost(post), viewer: { vote: vote?.state ?? null } };
  }

  /**
   * A post by its number on a public board: the address the public board pages use. A merged
   * duplicate comes with the number of the post it was merged into (on the same board), so its
   * page can redirect there. Anything else is FeedbackPostNotFoundError.
   */
  async postOnBoard(
    scope: FeedbackScope,
    slug: string,
    number: number,
  ): Promise<{ post: PublicPost; mergedIntoNumber: number | null }> {
    const board = await this.publicBoard(scope, slug);
    const posts = new FeedbackPostRepo(this.deps.db);
    const post = await posts.findByNumber(scope, board.id, number);
    if (post === undefined) {
      throw new FeedbackPostNotFoundError(`${slug}#${String(number)}`);
    }
    const target = post.mergedIntoPostId === null ? undefined : await posts.find(scope, post.mergedIntoPostId);
    return { post: toPublicPost(post), mergedIntoNumber: target?.number ?? null };
  }

  /** The post's public comments, oldest first. */
  async comments(
    scope: FeedbackScope,
    postId: string,
    page: FeedbackPage,
    viewer?: string,
  ): Promise<PublicPage<PublicComment>> {
    await this.publicPost(scope, postId);
    const rows = await this.deps.comments.listForPublic(scope, postId, { limit: page.limit + 1, offset: page.offset });
    return pageOf(
      rows.map(row => toPublicComment(row, viewer)),
      page,
    );
  }

  /** The end user's vote, counted at once (their app's server signed who they are). Idempotent. */
  async vote(
    scope: FeedbackScope,
    postId: string,
    endUserId: string,
    source: PublicVoteSource,
    state: FeedbackVoteState = FeedbackVoteStates.counted,
  ): Promise<{ vote: FeedbackVoteState; voteCount: number }> {
    await this.publicPost(scope, postId);
    const result = await this.deps.votes.vote(scope, postId, endUserId, { source, state });
    return { vote: result.vote.state, voteCount: result.post.voteCount };
  }

  /** Take the end user's vote back. Idempotent. */
  async unvote(scope: FeedbackScope, postId: string, endUserId: string): Promise<{ vote: null; voteCount: number }> {
    await this.publicPost(scope, postId);
    const post = await this.deps.votes.unvote(scope, postId, endUserId);
    return { vote: null, voteCount: post.voteCount };
  }

  /** The end user's comment, always public. */
  async comment(scope: FeedbackScope, postId: string, endUserId: string, body: string): Promise<PublicComment> {
    await this.publicPost(scope, postId);
    const row = await this.deps.comments.createAsEndUser(scope, postId, endUserId, body);
    return {
      id: row.id,
      authorKind: row.authorKind,
      isOfficial: row.isOfficial,
      isMine: true,
      body: row.body,
      createdAt: row.createdAt,
    };
  }

  /** A signed-in end user's post on the board: under review, with their vote. */
  async createPost(
    scope: FeedbackScope,
    slug: string,
    endUserId: string,
    input: { title: string; body?: string; categoryId?: string; source: PublicVoteSource },
  ): Promise<PublicPost> {
    const board = await this.publicBoard(scope, slug);
    const post = await this.deps.posts.createAsEndUser(scope, endUserId, { ...input, boardId: board.id });
    return toPublicPost(post);
  }

  /** The board's posts most like `query`, so an end user about to post can vote instead; with a
   * viewer, each with their own vote. */
  async similar(
    scope: FeedbackScope,
    slug: string,
    query: string,
    limit: number,
    viewer?: string,
  ): Promise<PublicListedPost[]> {
    const board = await this.publicBoard(scope, slug);
    const words = wordsOf(query);
    if (words.length === 0) {
      return [];
    }
    const rows = await new FeedbackPostRepo(this.deps.db).similar(scope, board.id, words, limit);
    return await this.withViewerVotes(
      scope,
      rows.map(row => toPublicPost(row)),
      viewer,
    );
  }

  /** Follow or stop following a post. Idempotent; an opt-out outlives later votes. */
  async setSubscribed(
    scope: FeedbackScope,
    postId: string,
    endUserId: string,
    isSubscribed: boolean,
  ): Promise<{ subscribed: boolean }> {
    await this.publicPost(scope, postId);
    const row = isSubscribed
      ? await this.deps.subscriptions.subscribe(scope, postId, endUserId)
      : await this.deps.subscriptions.unsubscribe(scope, postId, endUserId);
    return { subscribed: row.unsubscribedAt === null };
  }

  /**
   * What a sitemap lists for the project: each public board, when it last changed, and its live
   * posts by number (merged duplicates left out), the most recently changed first, at most
   * SITEMAP_POST_LIMIT across the boards.
   */
  /** A public board's published changelog, newest first (#176). */
  async changelog(scope: FeedbackScope, slug: string, page: FeedbackPage): Promise<PublicPage<PublicChangelogEntry>> {
    const board = await this.publicBoard(scope, slug);
    const rows = await new ChangelogEntryRepo(this.deps.db).listPublished(scope, board.id, {
      limit: page.limit + 1,
      offset: page.offset,
    });
    return pageOf(await this.publicEntries(rows), page);
  }

  /** One published entry of a public board by its slug; a draft, scheduled or missing one is ChangelogEntryNotFoundError. */
  async changelogEntry(scope: FeedbackScope, boardSlug: string, entrySlug: string): Promise<PublicChangelogEntry> {
    const board = await this.publicBoard(scope, boardSlug);
    const row = await new ChangelogEntryRepo(this.deps.db).findPublishedBySlug(scope, board.id, entrySlug);
    if (row === undefined) {
      throw new ChangelogEntryNotFoundError(entrySlug);
    }
    const [entry] = await this.publicEntries([row]);
    if (entry === undefined) {
      throw new ChangelogEntryNotFoundError(entrySlug);
    }
    return entry;
  }

  /**
   * How many entries were published since the end user last looked: their stored cursor when the
   * request names them, else `since` (a widget keeps it on the device for visitors), else every
   * entry. Counts up to CHANGELOG_UNREAD_CAP.
   */
  async changelogUnread(
    scope: FeedbackScope,
    slug: string,
    viewer: { endUserId?: string; since?: Date },
  ): Promise<{ count: number; lastSeenAt: Date | null }> {
    const board = await this.publicBoard(scope, slug);
    const stored =
      viewer.endUserId === undefined
        ? null
        : await new ChangelogReadRepo(this.deps.db).lastSeenAt(scope, board.id, viewer.endUserId);
    const lastSeenAt = stored ?? viewer.since ?? null;
    const count = await new ChangelogEntryRepo(this.deps.db).countPublishedSince(
      scope,
      board.id,
      lastSeenAt,
      CHANGELOG_UNREAD_CAP,
    );
    return { count, lastSeenAt };
  }

  /** The end user has read the board's changelog up to now; the cursor never moves back. */
  async markChangelogSeen(scope: FeedbackScope, slug: string, endUserId: string): Promise<{ lastSeenAt: Date }> {
    const board = await this.publicBoard(scope, slug);
    const lastSeenAt = await new ChangelogReadRepo(this.deps.db).markSeen(scope, board.id, endUserId, this.now());
    return { lastSeenAt };
  }

  /** The published entries that announce the post on a public board, newest first. */
  async changelogForPost(scope: FeedbackScope, postId: string) {
    const post = await this.publicPost(scope, postId);
    const rows = await new ChangelogEntryRepo(this.deps.db).listPublishedForPost(scope, post.id, POST_CHANGELOG_LIMIT);
    return rows.map(row => ({ slug: row.slug, title: row.title, publishedAt: row.publishedAt ?? new Date(0) }));
  }

  async sitemap(scope: FeedbackScope): Promise<
    {
      slug: string;
      updatedAt: Date;
      posts: { number: number; updatedAt: Date }[];
      changelog: { slug: string; updatedAt: Date }[];
    }[]
  > {
    const all = await new FeedbackBoardRepo(this.deps.db).list(scope);
    const boards = all.filter(board => board.isPublic);
    const posts = await new FeedbackPostRepo(this.deps.db).listForSitemap(
      scope,
      boards.map(board => board.id),
      SITEMAP_POST_LIMIT,
    );
    const entries = await new ChangelogEntryRepo(this.deps.db).listPublishedForSitemap(
      scope,
      boards.map(board => board.id),
      SITEMAP_CHANGELOG_LIMIT,
    );
    return boards.map(board => {
      const own = posts.filter(post => post.boardId === board.id);
      const changelog = entries
        .filter(entry => entry.boardId === board.id)
        .map(entry => ({ slug: entry.slug, updatedAt: entry.updatedAt }));
      const latest = new Date(Math.max(board.updatedAt.getTime(), ...own.map(post => post.updatedAt.getTime())));
      return {
        slug: board.slug,
        updatedAt: latest,
        posts: own.map(post => ({ number: post.number, updatedAt: post.updatedAt })),
        changelog,
      };
    });
  }

  /** The title of a post on a public board, for the pages its links open. */
  async postTitle(scope: FeedbackScope, postId: string): Promise<string> {
    const post = await this.publicPost(scope, postId);
    return post.title;
  }
}
