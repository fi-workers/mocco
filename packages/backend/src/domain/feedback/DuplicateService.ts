// Suggested duplicates for staff (#181). The `feedback.duplicates.detect` job sweeps every minute:
// each post not compared yet is matched against the older posts on its board by the words of its
// title, and the close ones become open pairs in the board's queue ("#7 may be the same as #3").
// Staff merge a pair (MergeService; a merged post leaves every pair it is in) or dismiss it, and a
// dismissed pair is never suggested again. Matching is by shared title words, the same words the
// public form's "similar posts" uses; embeddings are a later slice of #181.
import { AuditActions } from '@mocco/common/audit';
import { FeedbackDuplicateMethods } from '@mocco/common/feedback';

import { FeedbackDuplicateNotFoundError } from '@backend/domain/feedback/errors';
import { wordsOf } from '@backend/domain/feedback/PublicBoardService';
import { FeedbackDuplicateCandidateRepo } from '@backend/domain/feedback/repos/duplicate-candidate.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { FeedbackDuplicatePair } from '@backend/domain/feedback/repos/duplicate-candidate.repo';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

export const DuplicatePolicy = {
  /** Posts one sweep compares. */
  postsPerRun: 50,
  /** Older posts the word search returns for one post, before scoring. */
  searchLimit: 20,
  /** Pairs one post may get, the closest first. */
  pairsPerPost: 3,
  /** Title words two posts must share... */
  minSharedWords: 2,
  /** ...and the share of the newer title's words they must cover. */
  minScore: 0.5,
} as const;

/** Words too common in requests to say two titles are about the same thing. */
const FILLER = new Set([
  'a',
  'add',
  'all',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'could',
  'feature',
  'for',
  'from',
  'have',
  'how',
  'in',
  'is',
  'it',
  'let',
  'like',
  'me',
  'more',
  'my',
  'need',
  'new',
  'no',
  'not',
  'of',
  'on',
  'option',
  'or',
  'please',
  'should',
  'so',
  'support',
  'that',
  'the',
  'this',
  'to',
  'us',
  'use',
  'want',
  'we',
  'when',
  'with',
  'would',
  'you',
  'your',
]);

/** The title's words that say what it is about. */
export const keyWordsOf = (title: string): string[] => wordsOf(title).filter(word => !FILLER.has(word));

/** How much of `words` (the newer title's) the other title has, 0 to 1, and how many it shares. */
export function titleOverlap(words: readonly string[], otherTitle: string): { shared: number; score: number } {
  if (words.length === 0) {
    return { shared: 0, score: 0 };
  }
  const other = new Set(wordsOf(otherTitle));
  const shared = words.filter(word => other.has(word)).length;
  return { shared, score: shared / words.length };
}

export interface DuplicateServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  boards: Pick<BoardService, 'requireBoard'>;
  now?: () => Date;
}

export class DuplicateService {
  constructor(private readonly deps: DuplicateServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async pairsFor(post: FeedbackPostRow) {
    const words = keyWordsOf(post.title);
    if (words.length < DuplicatePolicy.minSharedWords) {
      return [];
    }
    const scope = { workspaceId: post.workspaceId, projectId: post.projectId };
    const found = await new FeedbackPostRepo(this.deps.db).similar(
      scope,
      post.boardId,
      words,
      DuplicatePolicy.searchLimit,
    );
    return found
      .filter(other => other.number < post.number)
      .map(other => ({ other, ...titleOverlap(words, other.title) }))
      .filter(match => match.shared >= DuplicatePolicy.minSharedWords && match.score >= DuplicatePolicy.minScore)
      .toSorted((left, right) => right.score - left.score || right.other.voteCount - left.other.voteCount)
      .slice(0, DuplicatePolicy.pairsPerPost)
      .map(match => ({
        ...scope,
        boardId: post.boardId,
        postId: post.id,
        candidatePostId: match.other.id,
        score: match.score,
        method: FeedbackDuplicateMethods.fulltext,
      }));
  }

  /** Compare the posts not compared yet with their boards' older posts; returns how many. */
  async detectDue(): Promise<number> {
    const repo = new FeedbackDuplicateCandidateRepo(this.deps.db);
    const due = await repo.unchecked(DuplicatePolicy.postsPerRun);
    // One post at a time, so each sees the pairs of the ones before it settled.
    await due.reduce(async (previous, post) => {
      await previous;
      // A merged post is already someone's duplicate: nothing to suggest.
      if (post.mergedIntoPostId === null) {
        await repo.insertMany(await this.pairsFor(post));
      }
    }, Promise.resolve());
    await repo.markChecked(
      due.map(post => post.id),
      this.now(),
    );
    return due.length;
  }

  /** A board's open pairs, the newest first, with both posts; another project's board is
   * FeedbackBoardNotFoundError. */
  async list(scope: FeedbackScope, boardId: string, limit: number): Promise<FeedbackDuplicatePair[]> {
    await this.deps.boards.requireBoard(scope, boardId);
    return await new FeedbackDuplicateCandidateRepo(this.deps.db).listOpen(scope, boardId, limit);
  }

  async countOpen(scope: FeedbackScope, boardId: string): Promise<number> {
    await this.deps.boards.requireBoard(scope, boardId);
    return await new FeedbackDuplicateCandidateRepo(this.deps.db).countOpen(scope, boardId);
  }

  /** The posts aren't the same request: the pair leaves the queue for good. */
  async dismiss(scope: FeedbackScope, actorUserId: string, id: string): Promise<void> {
    const row = await new FeedbackDuplicateCandidateRepo(this.deps.db).dismiss(scope, id, {
      userId: actorUserId,
      at: this.now(),
    });
    if (row === undefined) {
      throw new FeedbackDuplicateNotFoundError(id);
    }
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.feedbackDuplicateDismissed,
      subjectType: 'feedback_post',
      subjectId: row.postId,
      payload: { projectId: scope.projectId, boardId: row.boardId, candidatePostId: row.candidatePostId },
    });
  }
}
