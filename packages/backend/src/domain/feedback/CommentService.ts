// Comments on feedback posts (#173): end users' comments, and the team's, which may be the
// official response (public, flagged) or an internal note (team only). A post's `comment_count`
// counts its public comments and moves in the transaction that writes one. Reads come in two
// projections: the team's sees everything; the public one leaves out internal notes and staff ids.
import { FeedbackCommentAuthorKinds } from '@mocco/common/feedback';

import { FeedbackOfficialInternalError, FeedbackPostNotFoundError } from '@backend/domain/feedback/errors';
import { FeedbackCommentRepo } from '@backend/domain/feedback/repos/comment.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';

import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackCommentRow } from '@backend/domain/feedback/repos/comment.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackCommentAuthorKind, FeedbackCommentInput, FeedbackPage } from '@mocco/common/feedback';

export interface CommentServiceDeps {
  db: Db;
  posts: Pick<PostService, 'requirePost'>;
}

/** A comment as the public board shows it: no internal notes, no team member's id. */
export interface FeedbackPublicComment {
  id: string;
  authorKind: FeedbackCommentAuthorKind;
  /** The end user's id on their own comments; null on the team's. */
  authorEndUserId: string | null;
  body: string;
  isOfficial: boolean;
  createdAt: Date;
}

export const toPublicComment = (row: FeedbackCommentRow): FeedbackPublicComment => ({
  id: row.id,
  authorKind: row.authorKind,
  authorEndUserId: row.authorEndUserId,
  body: row.body,
  isOfficial: row.isOfficial,
  createdAt: row.createdAt,
});

export class CommentService {
  constructor(private readonly deps: CommentServiceDeps) {}

  /** Insert the comment and, when it is public, count it on the post, in one transaction. */
  private async insert(
    scope: FeedbackScope,
    postId: string,
    row: Omit<Parameters<FeedbackCommentRepo['insert']>[0], 'workspaceId' | 'postId'>,
  ): Promise<FeedbackCommentRow> {
    return await this.deps.db.transaction(async tx => {
      const posts = new FeedbackPostRepo(tx);
      if ((await posts.findForUpdate(scope, postId)) === undefined) {
        throw new FeedbackPostNotFoundError(postId);
      }
      const comment = await new FeedbackCommentRepo(tx).insert({ ...row, workspaceId: scope.workspaceId, postId });
      if (!comment.isInternal) {
        await posts.addToCount(scope, postId, 'commentCount', 1);
      }
      return comment;
    });
  }

  /** A team member's comment: plain, the official response, or an internal note. */
  async createAsStaff(
    scope: FeedbackScope,
    actorUserId: string,
    postId: string,
    input: FeedbackCommentInput,
  ): Promise<FeedbackCommentRow> {
    if (input.isOfficial && input.isInternal) {
      throw new FeedbackOfficialInternalError();
    }
    return await this.insert(scope, postId, {
      authorKind: FeedbackCommentAuthorKinds.staff,
      authorUserId: actorUserId,
      body: input.body,
      isOfficial: input.isOfficial,
      isInternal: input.isInternal,
    });
  }

  /** An end user's comment; always public, never official. */
  async createAsEndUser(
    scope: FeedbackScope,
    postId: string,
    endUserId: string,
    body: string,
  ): Promise<FeedbackCommentRow> {
    return await this.insert(scope, postId, {
      authorKind: FeedbackCommentAuthorKinds.endUser,
      authorEndUserId: endUserId,
      body,
    });
  }

  /** The post's comments for the team, oldest first, internal notes included. */
  async listForStaff(scope: FeedbackScope, postId: string, page: FeedbackPage): Promise<FeedbackCommentRow[]> {
    await this.deps.posts.requirePost(scope, postId);
    return await new FeedbackCommentRepo(this.deps.db).listForPost(scope.workspaceId, postId, {
      ...page,
      withInternal: true,
    });
  }

  /** The post's comments for the public board, oldest first: no internal notes, no staff ids. */
  async listForPublic(scope: FeedbackScope, postId: string, page: FeedbackPage): Promise<FeedbackPublicComment[]> {
    await this.deps.posts.requirePost(scope, postId);
    const rows = await new FeedbackCommentRepo(this.deps.db).listForPost(scope.workspaceId, postId, {
      ...page,
      withInternal: false,
    });
    return rows.map(row => toPublicComment(row));
  }
}
