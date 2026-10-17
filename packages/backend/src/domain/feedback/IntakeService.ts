// Requests from elsewhere in Mocco becoming posts (#182). Staff open a messenger conversation and
// choose "Convert to feedback": the preview pre-fills a title and details from the request, shows
// the board's posts it may repeat (the duplicate matching's words) and the posts the source already
// became. Converting makes a new post, or adds the request to an existing one, and records the
// source with the request's words. The requester votes for it when the source knows who they are
// (a signed-in app user: the same end-user id the board's tokens carry); a guest known only by an
// email address doesn't, since that address was never confirmed for the board. Converting a source
// that already became a post finds that post instead of making another, and a vote counts once.
//
// The feedback domain reads sources only through FeedbackSourceReader; each product implements it
// (domain/messenger/feedback-source.ts) and the composition root passes them in.
import { AuditActions } from '@mocco/common/audit';
import { FeedbackVoteSources } from '@mocco/common/feedback';

import { keyWordsOf } from '@backend/domain/feedback/DuplicateService';
import {
  FeedbackPostMergedError,
  FeedbackPostNotFoundError,
  FeedbackSourceNotFoundError,
} from '@backend/domain/feedback/errors';
import { FeedbackPostSourceRepo } from '@backend/domain/feedback/repos/post-source.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { PostService } from '@backend/domain/feedback/PostService';
import type { FeedbackPostSourceRow } from '@backend/domain/feedback/repos/post-source.repo';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { VoteService } from '@backend/domain/feedback/VoteService';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackConvertInput, FeedbackSourceType } from '@mocco/common/feedback';

/** What a source says about the request, as its product reads it. */
export interface FeedbackSourceSnapshot {
  /** A title to start from: the request's first line, shortened. */
  suggestedTitle: string;
  /** The request's words (at most FEEDBACK_SOURCE_EXCERPT_MAX characters). */
  excerpt: string;
  /** The requester's end-user id (the app's id for them), or null when the source doesn't know it. */
  endUserId: string | null;
}

/** One product's sources, read within a project; undefined when the project has no such source. */
export interface FeedbackSourceReader {
  read(scope: FeedbackScope, sourceId: string): Promise<FeedbackSourceSnapshot | undefined>;
}

export type FeedbackSourceReaders = Partial<Record<FeedbackSourceType, FeedbackSourceReader>>;

/** How many of the board's posts the preview offers as ones the request may repeat. */
export const INTAKE_SIMILAR_LIMIT = 5;

export interface IntakeServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  boards: Pick<BoardService, 'requireBoard'>;
  posts: Pick<PostService, 'create'>;
  votes: Pick<VoteService, 'vote'>;
  sources: FeedbackSourceReaders;
}

export interface IntakePreview {
  source: FeedbackSourceSnapshot;
  /** The posts this source already became, with the link. */
  linked: { source: FeedbackPostSourceRow; post: FeedbackPostRow }[];
  /** The board's live posts the request may repeat, the closest first. */
  similar: FeedbackPostRow[];
}

export interface IntakeResult {
  post: FeedbackPostRow;
  /** False when the source was already linked to this post (nothing new was recorded). */
  isNew: boolean;
  /** Whether the requester's vote was recorded (they are known and hadn't voted). */
  isVoteAdded: boolean;
}

export class IntakeService {
  constructor(private readonly deps: IntakeServiceDeps) {}

  private async snapshot(scope: FeedbackScope, sourceType: FeedbackSourceType, sourceId: string) {
    const snapshot = await this.deps.sources[sourceType]?.read(scope, sourceId);
    if (snapshot === undefined) {
      throw new FeedbackSourceNotFoundError(sourceType, sourceId);
    }
    return snapshot;
  }

  /** The live post a link points at: the post, or the one it was merged into. */
  private async live(scope: FeedbackScope, post: FeedbackPostRow): Promise<FeedbackPostRow> {
    if (post.mergedIntoPostId === null) {
      return post;
    }
    return (await new FeedbackPostRepo(this.deps.db).find(scope, post.mergedIntoPostId)) ?? post;
  }

  private async target(
    scope: FeedbackScope,
    actorUserId: string,
    input: FeedbackConvertInput,
    sources: FeedbackPostSourceRepo,
  ): Promise<{ post: FeedbackPostRow; isNew: boolean; existing?: undefined } | { existing: FeedbackPostRow }> {
    if ('intoPostId' in input) {
      const post = await new FeedbackPostRepo(this.deps.db).find(scope, input.intoPostId);
      if (post === undefined) {
        throw new FeedbackPostNotFoundError(input.intoPostId);
      }
      if (post.mergedIntoPostId !== null) {
        throw new FeedbackPostMergedError(post.id, post.mergedIntoPostId);
      }
      return { post, isNew: false };
    }
    const [already] = await sources.postsOf(scope, input.sourceType, input.sourceId);
    if (already !== undefined) {
      return { existing: await this.live(scope, already.post) };
    }
    const post = await this.deps.posts.create(scope, actorUserId, {
      boardId: input.boardId,
      title: input.title,
      ...(input.body !== undefined && { body: input.body }),
    });
    return { post, isNew: true };
  }

  /** What converting the source would start from, on `boardId`. */
  async preview(
    scope: FeedbackScope,
    sourceType: FeedbackSourceType,
    sourceId: string,
    boardId: string,
  ): Promise<IntakePreview> {
    await this.deps.boards.requireBoard(scope, boardId);
    const source = await this.snapshot(scope, sourceType, sourceId);
    const linked = await new FeedbackPostSourceRepo(this.deps.db).postsOf(scope, sourceType, sourceId);
    const words = keyWordsOf(`${source.suggestedTitle} ${source.excerpt}`);
    const similar =
      words.length === 0
        ? []
        : await new FeedbackPostRepo(this.deps.db).similar(scope, boardId, words, INTAKE_SIMILAR_LIMIT);
    return { source, linked, similar };
  }

  /** The posts a source became, for its product's page ("Linked to #12"); a source outside the
   * project is FeedbackSourceNotFoundError. */
  async postsOf(scope: FeedbackScope, sourceType: FeedbackSourceType, sourceId: string) {
    await this.snapshot(scope, sourceType, sourceId);
    return await new FeedbackPostSourceRepo(this.deps.db).postsOf(scope, sourceType, sourceId);
  }

  /** Where a post came from, oldest first (staff only: excerpts quote the requester). */
  async sourcesOf(scope: FeedbackScope, postId: string): Promise<FeedbackPostSourceRow[]> {
    return await new FeedbackPostSourceRepo(this.deps.db).ofPost(scope, postId);
  }

  /**
   * Make the source a new post on `boardId`, or add it to `intoPostId`. A source that already
   * became a post (and no `intoPostId`) answers that post, live. A merged `intoPostId` is
   * FeedbackPostMergedError; a source not in the project is FeedbackSourceNotFoundError.
   */
  async convert(scope: FeedbackScope, actorUserId: string, input: FeedbackConvertInput): Promise<IntakeResult> {
    const source = await this.snapshot(scope, input.sourceType, input.sourceId);
    const sources = new FeedbackPostSourceRepo(this.deps.db);
    const target = await this.target(scope, actorUserId, input, sources);
    if (target.existing !== undefined) {
      return { post: target.existing, isNew: false, isVoteAdded: false };
    }
    const { post, isNew } = target;
    const link = await sources.insert({
      ...scope,
      postId: post.id,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      excerpt: source.excerpt,
      endUserId: source.endUserId,
      createdByUserId: actorUserId,
    });
    let after = post;
    if (source.endUserId !== null) {
      // Idempotent: a requester who voted already keeps their one vote, and the count stays.
      ({ post: after } = await this.deps.votes.vote(scope, post.id, source.endUserId, {
        source: FeedbackVoteSources.intake,
        recordedByUserId: actorUserId,
      }));
    }
    if (link !== undefined) {
      await this.deps.audit.record(scope.workspaceId, {
        actorUserId,
        action: AuditActions.feedbackPostConverted,
        subjectType: 'feedback_post',
        subjectId: post.id,
        payload: {
          projectId: scope.projectId,
          boardId: post.boardId,
          number: post.number,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          isNewPost: isNew,
        },
      });
    }
    return { post: after, isNew: link !== undefined, isVoteAdded: after.voteCount > post.voteCount };
  }
}
