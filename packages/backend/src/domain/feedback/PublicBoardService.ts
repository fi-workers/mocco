// The public side of a project's feedback boards (#174): what /v1/feedback serves to an app,
// a widget or a public board page, and what the app's signed-in end users do there. Every
// answer is an explicit projection: a private board, its posts and their comments read as
// not found; internal notes, the team's ids and other end users' ids are never in it. Writes
// go through VoteService, CommentService, SubscriptionService and PostService, so their locks
// and counters hold here too.
import { FeedbackCommentAuthorKinds, FeedbackVoteStates, RoadmapColumns } from '@mocco/common/feedback';
import { FeedbackPublicSorts } from '@mocco/common/feedback-v1';

import {
  FeedbackBoardNotFoundError,
  FeedbackCategoryNotFoundError,
  FeedbackPostNotFoundError,
} from '@backend/domain/feedback/errors';
import { FeedbackBoardRepo } from '@backend/domain/feedback/repos/board.repo';
import { FeedbackCategoryRepo } from '@backend/domain/feedback/repos/category.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { FeedbackVoteRepo } from '@backend/domain/feedback/repos/vote.repo';

import type { CommentService, FeedbackPublicComment } from '@backend/domain/feedback/CommentService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackBoardRow } from '@backend/domain/feedback/repos/board.repo';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { SubscriptionService } from '@backend/domain/feedback/SubscriptionService';
import type { VoteService } from '@backend/domain/feedback/VoteService';
import type { Db } from '@backend/infra/db/types';
import type {
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

  /** The board's posts, merged duplicates left out, filtered by status and category slug. */
  async posts(
    scope: FeedbackScope,
    slug: string,
    query: { status?: FeedbackPostStatus; category?: string; sort: FeedbackPublicSort } & FeedbackPage,
  ): Promise<PublicPage<PublicPost>> {
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
    return pageOf(
      rows.map(row => toPublicPost(row)),
      query,
    );
  }

  /** The board's roadmap: the most voted posts of each column. */
  async roadmap(scope: FeedbackScope, slug: string): Promise<Record<RoadmapColumn, PublicPost[]>> {
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
    return Object.fromEntries(columns) as Record<RoadmapColumn, PublicPost[]>;
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

  /** The board's posts most like `query`, so an end user about to post can vote instead. */
  async similar(scope: FeedbackScope, slug: string, query: string, limit: number): Promise<PublicPost[]> {
    const board = await this.publicBoard(scope, slug);
    const words = wordsOf(query);
    if (words.length === 0) {
      return [];
    }
    const rows = await new FeedbackPostRepo(this.deps.db).similar(scope, board.id, words, limit);
    return rows.map(row => toPublicPost(row));
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

  /** The title of a post on a public board, for the pages its links open. */
  async postTitle(scope: FeedbackScope, postId: string): Promise<string> {
    const post = await this.publicPost(scope, postId);
    return post.title;
  }
}
