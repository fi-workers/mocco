// Suggested duplicates for staff (#181). The `feedback.duplicates.detect` job sweeps every minute:
// each post not compared yet is matched against the older posts on its board by the words of its
// title, and the close ones become open pairs in the board's queue ("#7 may be the same as #3").
// Staff merge a pair (MergeService; a merged post leaves every pair it is in) or dismiss it, and a
// dismissed pair is never suggested again. Matching is by shared title words, the same words the
// public form's "similar posts" uses, and, with an embedder configured, by meaning: each sweep first
// embeds the posts with no vector for their current words (within a budget, the ones about to be
// compared first), then pairs a post with the older posts whose vectors are close to its own.
import { createHash } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackDuplicateMethods } from '@mocco/common/feedback';

import { FeedbackDuplicateNotFoundError } from '@backend/domain/feedback/errors';
import { wordsOf } from '@backend/domain/feedback/PublicBoardService';
import { FeedbackDuplicateCandidateRepo } from '@backend/domain/feedback/repos/duplicate-candidate.repo';
import { FeedbackPostEmbeddingRepo } from '@backend/domain/feedback/repos/post-embedding.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { Embedder } from '@backend/domain/feedback/embed/Embedder';
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
  /** Posts one sweep embeds (one call to the embedder). */
  embedPerRun: 100,
  /** Characters of a post (title, a blank line, body) sent to the embedder. */
  embedMaxChars: 4000,
  /** The cosine similarity of two posts' vectors that makes them a pair. */
  minEmbeddingScore: 0.8,
  /** Time one sweep spends comparing before leaving the rest to the next one. */
  sweepBudgetMs: 20_000,
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

/** The words a post's vector is made from. */
const contentOf = (post: Pick<FeedbackPostRow, 'title' | 'body'>) => `${post.title}\n\n${post.body}`;

/** What `content_hash` holds for a post: changed words make its vector stale. The repo hashes the
 * same text in SQL (sha256 of title, a blank line and body). */
export const contentHashOf = (post: Pick<FeedbackPostRow, 'title' | 'body'>): string =>
  createHash('sha256').update(contentOf(post), 'utf8').digest('hex');

/** `vector` scaled to length 1 (so cosine similarity is a dot product); all zeros stays as it is. */
export function unitLength(vector: readonly number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? [...vector] : vector.map(value => value / length);
}

/** A pair as the sweep inserts it. */
type PairRow = Parameters<FeedbackDuplicateCandidateRepo['insertMany']>[0][number];

export interface DuplicateServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  boards: Pick<BoardService, 'requireBoard'>;
  /** Matches posts by meaning too; without one, by title words only. */
  embedder?: Embedder;
  now?: () => Date;
}

export class DuplicateService {
  constructor(private readonly deps: DuplicateServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Embed the posts with no vector for their current words from the embedder's model, up to the
   * run's budget; an embedder that fails leaves them for the next sweep. */
  private async embedDue(embedder: Embedder): Promise<void> {
    const repo = new FeedbackPostEmbeddingRepo(this.deps.db);
    const due = await repo.due(embedder.model, DuplicatePolicy.embedPerRun);
    if (due.length === 0) {
      return;
    }
    try {
      const { model, dims, vectors } = await embedder.embed(
        due.map(post => contentOf(post).slice(0, DuplicatePolicy.embedMaxChars)),
      );
      const at = this.now();
      await repo.upsertMany(
        due.flatMap((post, index) => {
          const vector = vectors[index];
          return vector === undefined || vector.length !== dims || dims === 0
            ? []
            : [
                {
                  postId: post.id,
                  workspaceId: post.workspaceId,
                  model,
                  dims,
                  embedding: unitLength(vector),
                  contentHash: contentHashOf(post),
                  createdAt: at,
                },
              ];
        }),
      );
    } catch (error) {
      // Title words still pair this sweep's posts; the vectors come with a later sweep.
      console.warn(`[feedback] embedding ${String(due.length)} posts failed: ${String(error)}`);
    }
  }

  private async pairsFor(post: FeedbackPostRow): Promise<PairRow[]> {
    const byWords = await this.wordPairsFor(post);
    const { embedder } = this.deps;
    if (embedder === undefined || byWords.length >= DuplicatePolicy.pairsPerPost) {
      return byWords;
    }
    // A pair the title words found keeps their score; meaning adds the ones they missed.
    const found = new Set(byWords.map(pair => pair.candidatePostId));
    const near = await new FeedbackPostEmbeddingRepo(this.deps.db).nearestOlder(post, embedder.model, {
      minScore: DuplicatePolicy.minEmbeddingScore,
      limit: DuplicatePolicy.pairsPerPost,
    });
    const byMeaning = near
      .filter(match => !found.has(match.post.id))
      .slice(0, DuplicatePolicy.pairsPerPost - byWords.length)
      .map(match => ({
        workspaceId: post.workspaceId,
        projectId: post.projectId,
        boardId: post.boardId,
        postId: post.id,
        candidatePostId: match.post.id,
        score: Math.min(1, Math.max(0, match.score)),
        method: FeedbackDuplicateMethods.embedding,
      }));
    return [...byWords, ...byMeaning];
  }

  private async wordPairsFor(post: FeedbackPostRow): Promise<PairRow[]> {
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

  /** Compare the posts not compared yet with their boards' older posts, within the sweep's time
   * budget; returns how many. */
  async detectDue(): Promise<number> {
    if (this.deps.embedder !== undefined) {
      await this.embedDue(this.deps.embedder);
    }
    const repo = new FeedbackDuplicateCandidateRepo(this.deps.db);
    const due = await repo.unchecked(DuplicatePolicy.postsPerRun);
    const started = this.now().getTime();
    const checked: string[] = [];
    // One post at a time, so each sees the pairs of the ones before it settled.
    await due.reduce(async (previous, post) => {
      await previous;
      // Comparing by meaning scans the board's vectors: past the budget, the rest wait for the
      // next sweep (which always gets through one).
      if (checked.length > 0 && this.now().getTime() - started > DuplicatePolicy.sweepBudgetMs) {
        return;
      }
      // A merged post is already someone's duplicate: nothing to suggest.
      if (post.mergedIntoPostId === null) {
        await repo.insertMany(await this.pairsFor(post));
      }
      checked.push(post.id);
    }, Promise.resolve());
    await repo.markChecked(checked, this.now());
    return checked.length;
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
