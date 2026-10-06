// Posts on a project's feedback boards and their status history (#172). Every status a post
// takes, including the one it is created with, is a row in mocco_feedback_status_changes,
// written in the same transaction as the post.
import { AuditActions } from '@mocco/common/audit';
import { FeedbackPostStatuses, FeedbackStatusChangeReasons } from '@mocco/common/feedback';

import {
  FeedbackBoardNotFoundError,
  FeedbackPostNotFoundError,
  FeedbackStatusUnchangedError,
} from '@backend/domain/feedback/errors';
import { FeedbackBoardRepo } from '@backend/domain/feedback/repos/board.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { FeedbackStatusChangeRepo } from '@backend/domain/feedback/repos/status-change.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackStatusChangeRow } from '@backend/domain/feedback/repos/status-change.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type {
  FeedbackPostCreateInput,
  FeedbackPostListQuery,
  FeedbackPostStatus,
  FeedbackPostUpdateInput,
} from '@mocco/common/feedback';

export interface PostServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  boards: Pick<BoardService, 'requireBoard' | 'requireCategory'>;
  now?: () => Date;
}

export class PostService {
  constructor(private readonly deps: PostServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** When a post in `status` shipped: now when it is shipped, else null. */
  private shippedAtFor(status: FeedbackPostStatus): Date | null {
    return status === FeedbackPostStatuses.shipped ? this.now() : null;
  }

  /** The post, or FeedbackPostNotFoundError. */
  async requirePost(scope: FeedbackScope, postId: string): Promise<FeedbackPostRow> {
    const post = await new FeedbackPostRepo(this.deps.db).find(scope, postId);
    if (post === undefined) {
      throw new FeedbackPostNotFoundError(postId);
    }
    return post;
  }

  /** The post with its status history, oldest first. */
  async get(
    scope: FeedbackScope,
    postId: string,
  ): Promise<{ post: FeedbackPostRow; history: FeedbackStatusChangeRow[] }> {
    const post = await this.requirePost(scope, postId);
    const history = await new FeedbackStatusChangeRepo(this.deps.db).listForPost(scope.workspaceId, postId);
    return { post, history };
  }

  /** A board's posts; another project's board is FeedbackBoardNotFoundError, not an empty list. */
  async list(scope: FeedbackScope, query: FeedbackPostListQuery): Promise<FeedbackPostRow[]> {
    await this.deps.boards.requireBoard(scope, query.boardId);
    return await new FeedbackPostRepo(this.deps.db).list(scope, query);
  }

  /** Create a post with the board's next number; its first status is recorded as `created`. */
  async create(scope: FeedbackScope, actorUserId: string, input: FeedbackPostCreateInput): Promise<FeedbackPostRow> {
    const categoryId = input.categoryId ?? null;
    if (categoryId !== null) {
      await this.deps.boards.requireCategory(scope, input.boardId, categoryId);
    }
    const status = input.status ?? FeedbackPostStatuses.underReview;
    return await this.deps.db.transaction(async tx => {
      const number = await new FeedbackBoardRepo(tx).takePostNumber(scope, input.boardId);
      if (number === undefined) {
        throw new FeedbackBoardNotFoundError(input.boardId);
      }
      const post = await new FeedbackPostRepo(tx).insert({
        ...scope,
        boardId: input.boardId,
        categoryId,
        number,
        title: input.title,
        body: input.body ?? '',
        status,
        shippedAt: this.shippedAtFor(status),
        authorUserId: actorUserId,
      });
      await new FeedbackStatusChangeRepo(tx).append({
        workspaceId: scope.workspaceId,
        postId: post.id,
        fromStatus: null,
        toStatus: status,
        reason: FeedbackStatusChangeReasons.created,
        actorUserId,
      });
      return post;
    });
  }

  /** Edit the title, body or category; only the given fields change. */
  async update(scope: FeedbackScope, postId: string, input: FeedbackPostUpdateInput): Promise<FeedbackPostRow> {
    const post = await this.requirePost(scope, postId);
    if (input.categoryId !== undefined && input.categoryId !== null) {
      await this.deps.boards.requireCategory(scope, post.boardId, input.categoryId);
    }
    const updated = await new FeedbackPostRepo(this.deps.db).update(scope, postId, {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.body !== undefined && { body: input.body }),
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    });
    if (updated === undefined) {
      throw new FeedbackPostNotFoundError(postId);
    }
    return updated;
  }

  /**
   * Move the post to `status` (any status to any other) and record the change. Entering shipped
   * sets `shippedAt`; leaving it clears it. The same status again is FeedbackStatusUnchangedError.
   */
  async setStatus(
    scope: FeedbackScope,
    actorUserId: string,
    postId: string,
    status: FeedbackPostStatus,
  ): Promise<{ post: FeedbackPostRow; change: FeedbackStatusChangeRow }> {
    const result = await this.deps.db.transaction(async tx => {
      const posts = new FeedbackPostRepo(tx);
      const current = await posts.findForUpdate(scope, postId);
      if (current === undefined) {
        throw new FeedbackPostNotFoundError(postId);
      }
      if (current.status === status) {
        throw new FeedbackStatusUnchangedError(status);
      }
      const post = await posts.setStatus(scope, postId, { status, shippedAt: this.shippedAtFor(status) });
      const change = await new FeedbackStatusChangeRepo(tx).append({
        workspaceId: scope.workspaceId,
        postId,
        fromStatus: current.status,
        toStatus: status,
        reason: FeedbackStatusChangeReasons.manual,
        actorUserId,
      });
      return { post, change };
    });
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.feedbackPostStatusChanged,
      subjectType: 'feedback_post',
      subjectId: postId,
      payload: {
        projectId: scope.projectId,
        boardId: result.post.boardId,
        number: result.post.number,
        from: result.change.fromStatus,
        to: status,
      },
    });
    return result;
  }
}
