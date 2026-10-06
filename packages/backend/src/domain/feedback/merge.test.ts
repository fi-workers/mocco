import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import {
  FeedbackPostStatuses,
  FeedbackStatusChangeReasons,
  FeedbackVoteSources,
  FeedbackVoteStates,
} from '@mocco/common/feedback';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import {
  FeedbackMergeInvalidError,
  FeedbackPostMergedError,
  FeedbackPostNotFoundError,
} from '@backend/domain/feedback/errors';
import { FeedbackVoteRepo } from '@backend/domain/feedback/repos/vote.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';

const NOW = new Date('2026-10-06T12:00:00Z');
const page = { limit: 100, offset: 0 };
const byText = (left: string, right: string) => (left < right ? -1 : 1);
const web = { source: FeedbackVoteSources.web };
const pending = { source: FeedbackVoteSources.web, state: FeedbackVoteStates.pending };

/** The outcome of a call: 'ok', or the error's class name. */
const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.name : 'unknown';
  }
};

describe('merging feedback posts (pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let actor: string;
  let boardId: string;

  beforeEach(async () => {
    t = await createTestDb();
    feedback = createFeedbackDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      now: () => NOW,
    });
    const workspace = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning());
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspace.id, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId: workspace.id, projectId: project.id };
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    boardId = board.id;
  });
  afterEach(async () => {
    await t.close();
  });

  /** A post on the board that `voters` voted for (counted). */
  const post = async (title: string, voters: string[] = []) => {
    const created = await feedback.feedbackPosts.create(scope, actor, { boardId, title });
    await voters.reduce(async (previous, voter) => {
      await previous;
      await feedback.feedbackVotes.vote(scope, created.id, voter, web);
    }, Promise.resolve());
    return created.id;
  };
  const read = async (postId: string) => await feedback.feedbackPosts.requirePost(scope, postId);
  const mergedInto = async (postId: string) => {
    const row = await read(postId);
    return row.mergedIntoPostId;
  };
  const voteCount = async (postId: string) => {
    const row = await read(postId);
    return row.voteCount;
  };
  const voters = async (postId: string) => {
    const votes = await feedback.feedbackVotes.list(scope, postId, page);
    return votes.map(vote => `${vote.endUserId}:${vote.state}`).toSorted(byText);
  };
  const subscribers = async (postId: string) => {
    const rows = await feedback.feedbackSubscriptions.list(scope, postId, page);
    return rows.map(row => row.endUserId).toSorted(byText);
  };
  const counted = async (postId: string) => await new FeedbackVoteRepo(t.db).countCounted(scope.workspaceId, postId);

  it('keeps the union of voters on the target, counting someone who voted on both once', async () => {
    const source = await post('Dark theme', ['ann', 'bob', 'cy']);
    const target = await post('Dark mode', ['bob', 'dee']);
    // A pending vote on the target counts once the same person's counted vote moves in.
    await feedback.feedbackVotes.vote(scope, target, 'cy', pending);
    await feedback.feedbackVotes.vote(scope, source, 'eve', pending);

    const result = await feedback.feedbackMerges.merge(scope, actor, source, target);
    expect(result.target.voteCount).toBe(4);
    expect(await counted(target)).toBe(4);
    expect(await voters(target)).toEqual(['ann:counted', 'bob:counted', 'cy:counted', 'dee:counted', 'eve:pending']);
    const moved = await feedback.feedbackVotes.list(scope, target, page);
    expect(moved.find(vote => vote.endUserId === 'ann')?.source).toBe(FeedbackVoteSources.merge);
    // The duplicate keeps its own votes as its history.
    expect(result.source).toMatchObject({
      mergedIntoPostId: target,
      mergedAt: NOW,
      status: FeedbackPostStatuses.closed,
      voteCount: 3,
    });
    expect(await voters(source)).toEqual(['ann:counted', 'bob:counted', 'cy:counted', 'eve:pending']);
    const { history } = await feedback.feedbackPosts.get(scope, source);
    expect(history.map(row => [row.toStatus, row.reason])).toEqual([
      [FeedbackPostStatuses.underReview, FeedbackStatusChangeReasons.created],
      [FeedbackPostStatuses.closed, FeedbackStatusChangeReasons.merge],
    ]);
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.feedbackPostMerged));
    expect(audit.map(row => [row.subjectId, row.payload])).toEqual([
      [source, expect.objectContaining({ intoPostId: target, votesAdded: 2 })],
    ]);
  });

  it('moves subscribers, keeping opt-outs, and subscribes voters', async () => {
    const source = await post('Dark theme', ['ann', 'bob']);
    const target = await post('Dark mode', ['cy']);
    await feedback.feedbackSubscriptions.unsubscribe(scope, source, 'bob');
    await feedback.feedbackSubscriptions.subscribe(scope, source, 'dee');
    await feedback.feedbackSubscriptions.unsubscribe(scope, target, 'ann');

    expect(await subscribers(source)).toEqual(['ann', 'dee']);
    // Voting again doesn't undo an opt-out; subscribing does.
    await feedback.feedbackVotes.unvote(scope, source, 'bob');
    await feedback.feedbackVotes.vote(scope, source, 'bob', web);
    expect(await subscribers(source)).toEqual(['ann', 'dee']);

    await feedback.feedbackMerges.merge(scope, actor, source, target);
    // ann opted out on the target, bob on the source; both opt-outs stand.
    expect(await subscribers(target)).toEqual(['cy', 'dee']);
    await feedback.feedbackSubscriptions.subscribe(scope, target, 'ann');
    expect(await subscribers(target)).toEqual(['ann', 'cy', 'dee']);
  });

  it('re-parents posts merged into the source, so no chain forms', async () => {
    const first = await post('Night mode', ['ann']);
    const middle = await post('Dark theme', ['bob']);
    const target = await post('Dark mode', ['cy']);
    await feedback.feedbackMerges.merge(scope, actor, first, middle);
    await feedback.feedbackMerges.merge(scope, actor, middle, target);

    expect(await mergedInto(first)).toBe(target);
    expect(await mergedInto(middle)).toBe(target);
    expect(await voters(target)).toEqual(['ann:counted', 'bob:counted', 'cy:counted']);
    expect(await voteCount(target)).toBe(3);
    // Deleting the board deletes merged posts with the rest.
    await feedback.feedbackBoards.deleteBoard(scope, actor, boardId);
    await expect(read(first)).rejects.toBeInstanceOf(FeedbackPostNotFoundError);
  });

  it('refuses merging into or from a merged post, into itself, across boards and across projects', async () => {
    const a = await post('A');
    const b = await post('B');
    const c = await post('C');
    await feedback.feedbackMerges.merge(scope, actor, a, b);

    await expect(feedback.feedbackMerges.merge(scope, actor, c, a)).rejects.toBeInstanceOf(FeedbackPostMergedError);
    await expect(feedback.feedbackMerges.merge(scope, actor, a, c)).rejects.toBeInstanceOf(FeedbackPostMergedError);
    await expect(feedback.feedbackMerges.merge(scope, actor, c, c)).rejects.toBeInstanceOf(FeedbackMergeInvalidError);
    const other = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'bugs', name: 'Bugs' });
    const elsewhere = await feedback.feedbackPosts.create(scope, actor, { boardId: other.id, title: 'D' });
    await expect(feedback.feedbackMerges.merge(scope, actor, c, elsewhere.id)).rejects.toBeInstanceOf(
      FeedbackMergeInvalidError,
    );
    const project = await createProjectDomain(t.db).projects.create(scope.workspaceId, { name: 'B', handle: 'b' });
    await expect(
      feedback.feedbackMerges.merge({ ...scope, projectId: project.id }, actor, c, b),
    ).rejects.toBeInstanceOf(FeedbackPostNotFoundError);
    // A merged post takes no more votes or subscriptions; the error says where they go.
    await expect(feedback.feedbackVotes.vote(scope, a, 'ann', web)).rejects.toMatchObject({ intoPostId: b });
    await expect(feedback.feedbackSubscriptions.subscribe(scope, a, 'ann')).rejects.toBeInstanceOf(
      FeedbackPostMergedError,
    );
    expect(await mergedInto(c)).toBeNull();
  });

  it('serializes concurrent merges into one target and counts each voter once', async () => {
    const target = await post('Dark mode', ['ann']);
    const sources = await [
      ['ann', 'bob'],
      ['bob', 'cy'],
      ['cy', 'dee'],
      ['dee', 'ann', 'eve'],
    ].reduce<Promise<string[]>>(async (previous, names, index) => {
      const ids = await previous;
      return [...ids, await post(`Duplicate ${index}`, names)];
    }, Promise.resolve([]));

    const results = await Promise.all(
      sources.map(async source => await feedback.feedbackMerges.merge(scope, actor, source, target)),
    );
    expect(results.map(result => result.source.mergedIntoPostId)).toEqual([target, target, target, target]);
    expect(await voters(target)).toEqual(['ann:counted', 'bob:counted', 'cy:counted', 'dee:counted', 'eve:counted']);
    expect(await voteCount(target)).toBe(5);
    expect(await counted(target)).toBe(5);
  });

  it('lets only one of two crossing merges win, with votes arriving at the same time', async () => {
    const a = await post('A', ['ann']);
    const b = await post('B', ['bob']);
    const outcomes = await Promise.all([
      outcome(async () => await feedback.feedbackMerges.merge(scope, actor, a, b)),
      outcome(async () => await feedback.feedbackMerges.merge(scope, actor, b, a)),
      outcome(async () => await feedback.feedbackVotes.vote(scope, a, 'cy', web)),
      outcome(async () => await feedback.feedbackVotes.vote(scope, b, 'dee', web)),
    ]);
    expect(outcomes.slice(0, 2).toSorted(byText)).toEqual(['FeedbackPostMergedError', 'ok']);
    const [postA, postB] = [await read(a), await read(b)];
    const [winner, loser] = postA.mergedIntoPostId === null ? [postA, postB] : [postB, postA];
    expect(loser.mergedIntoPostId).toBe(winner.id);
    expect(winner.mergedIntoPostId).toBeNull();
    // Whatever order they ran in, the live post's count equals its counted votes.
    expect(winner.voteCount).toBe(await counted(winner.id));
    expect(await voters(winner.id)).toEqual(expect.arrayContaining(['ann:counted', 'bob:counted']));
  });
});
