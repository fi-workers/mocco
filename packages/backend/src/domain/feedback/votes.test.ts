import { randomUUID } from 'node:crypto';

import { FeedbackVoteSources, FeedbackVoteStates } from '@mocco/common/feedback';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { FeedbackPostNotFoundError, FeedbackVoteNotFoundError } from '@backend/domain/feedback/errors';
import { FeedbackVoteRepo } from '@backend/domain/feedback/repos/vote.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';

const NOW = new Date('2026-10-06T12:00:00Z');
const page = { limit: 100, offset: 0 };
const web = { source: FeedbackVoteSources.web };
const pending = { source: FeedbackVoteSources.web, state: FeedbackVoteStates.pending };

/** The post's vote count after `write`. */
const countAfter = async (write: () => Promise<{ post: { voteCount: number } } | { voteCount: number }>) => {
  const result = await write();
  const post = 'post' in result ? result.post : result;
  return post.voteCount;
};

/** A deterministic PRNG (Park–Miller), so the operation sequence is the same every run. */
const prng = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
};

describe('feedback votes (pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let actor: string;
  let postId: string;

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
    const post = await feedback.feedbackPosts.create(scope, actor, { boardId: board.id, title: 'Dark mode' });
    postId = post.id;
  });
  afterEach(async () => {
    await t.close();
  });

  const voteCount = async () => {
    const post = await feedback.feedbackPosts.requirePost(scope, postId);
    return post.voteCount;
  };
  const countedRows = async () => await new FeedbackVoteRepo(t.db).countCounted(scope.workspaceId, postId);

  it('takes one vote per end user; voting again changes nothing', async () => {
    const first = await feedback.feedbackVotes.vote(scope, postId, 'user-1', web);
    expect(first.vote).toMatchObject({
      endUserId: 'user-1',
      state: FeedbackVoteStates.counted,
      source: FeedbackVoteSources.web,
      countedAt: NOW,
    });
    expect(first.post.voteCount).toBe(1);
    const again = await feedback.feedbackVotes.vote(scope, postId, 'user-1', web);
    expect(again.vote.id).toBe(first.vote.id);
    expect(again.post.voteCount).toBe(1);
    await feedback.feedbackVotes.vote(scope, postId, 'user-2', {
      source: FeedbackVoteSources.staff,
      recordedByUserId: actor,
    });
    expect(await voteCount()).toBe(2);
    const votes = await feedback.feedbackVotes.list(scope, postId, page);
    expect(votes.map(vote => [vote.endUserId, vote.source, vote.recordedByUserId])).toEqual([
      ['user-2', FeedbackVoteSources.staff, actor],
      ['user-1', FeedbackVoteSources.web, null],
    ]);
  });

  it('counts a pending vote only once it is confirmed, or when the voter votes identified', async () => {
    const waiting = await feedback.feedbackVotes.vote(scope, postId, 'a@example.com', pending);
    expect(waiting.vote).toMatchObject({ state: FeedbackVoteStates.pending, countedAt: null });
    expect(waiting.post.voteCount).toBe(0);
    // A pending vote again is still the one pending vote.
    expect(
      await countAfter(async () => await feedback.feedbackVotes.vote(scope, postId, 'a@example.com', pending)),
    ).toBe(0);

    const confirmed = await feedback.feedbackVotes.confirm(scope, postId, 'a@example.com');
    expect(confirmed.vote).toMatchObject({ id: waiting.vote.id, state: FeedbackVoteStates.counted, countedAt: NOW });
    expect(confirmed.post.voteCount).toBe(1);
    // Confirming twice, or voting pending over a counted vote, counts nothing more.
    expect(await countAfter(async () => await feedback.feedbackVotes.confirm(scope, postId, 'a@example.com'))).toBe(1);
    const over = await feedback.feedbackVotes.vote(scope, postId, 'a@example.com', pending);
    expect([over.vote.state, over.post.voteCount]).toEqual([FeedbackVoteStates.counted, 1]);

    await feedback.feedbackVotes.vote(scope, postId, 'b@example.com', pending);
    const identified = await feedback.feedbackVotes.vote(scope, postId, 'b@example.com', web);
    expect(identified.vote.state).toBe(FeedbackVoteStates.counted);
    expect(identified.post.voteCount).toBe(2);

    await expect(feedback.feedbackVotes.confirm(scope, postId, 'nobody')).rejects.toBeInstanceOf(
      FeedbackVoteNotFoundError,
    );
  });

  it('takes a vote back; a pending one never counted, and no vote is no change', async () => {
    await feedback.feedbackVotes.vote(scope, postId, 'user-1', web);
    await feedback.feedbackVotes.vote(scope, postId, 'user-2', pending);
    expect(await countAfter(async () => await feedback.feedbackVotes.unvote(scope, postId, 'user-2'))).toBe(1);
    expect(await countAfter(async () => await feedback.feedbackVotes.unvote(scope, postId, 'user-1'))).toBe(0);
    expect(await countAfter(async () => await feedback.feedbackVotes.unvote(scope, postId, 'user-1'))).toBe(0);
    expect(await feedback.feedbackVotes.list(scope, postId, page)).toEqual([]);
  });

  it('keeps vote_count equal to the counted votes after any sequence of operations', async () => {
    const random = prng(173);
    const voters = ['u1', 'u2', 'u3', 'u4', 'u5'];
    const operations = Array.from({ length: 120 }, () => {
      const voter = voters[Math.floor(random() * voters.length)] ?? 'u1';
      const kind = Math.floor(random() * 4);
      return { voter, kind };
    });
    // In batches of six run at once, so writes to the one post overlap.
    await Array.from({ length: operations.length / 6 }, (_, index) =>
      operations.slice(index * 6, index * 6 + 6),
    ).reduce(async (previous, batch) => {
      await previous;
      await Promise.all(
        batch.map(async ({ voter, kind }) => {
          switch (kind) {
            case 0: {
              await feedback.feedbackVotes.vote(scope, postId, voter, web);
              break;
            }
            case 1: {
              await feedback.feedbackVotes.vote(scope, postId, voter, pending);
              break;
            }
            case 2: {
              try {
                await feedback.feedbackVotes.confirm(scope, postId, voter);
              } catch (error) {
                // Confirming without a vote is refused; the sequence goes on.
                expect(error).toBeInstanceOf(FeedbackVoteNotFoundError);
              }
              break;
            }
            default: {
              await feedback.feedbackVotes.unvote(scope, postId, voter);
            }
          }
        }),
      );
      expect(await voteCount()).toBe(await countedRows());
    }, Promise.resolve());
    expect(await voteCount()).toBe(await countedRows());
  });

  it('counts concurrent votes by one end user once and by many end users each', async () => {
    const same = await Promise.all(
      Array.from({ length: 8 }, async () => await feedback.feedbackVotes.vote(scope, postId, 'user-1', web)),
    );
    expect(new Set(same.map(result => result.vote.id)).size).toBe(1);
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => await feedback.feedbackVotes.vote(scope, postId, `u${index}`, web)),
    );
    expect(await voteCount()).toBe(9);
    expect(await countedRows()).toBe(9);
  });

  it("refuses another project's post", async () => {
    const other = await createProjectDomain(t.db).projects.create(scope.workspaceId, { name: 'B', handle: 'b' });
    const otherScope = { ...scope, projectId: other.id };
    await expect(feedback.feedbackVotes.vote(otherScope, postId, 'user-1', web)).rejects.toBeInstanceOf(
      FeedbackPostNotFoundError,
    );
    await expect(feedback.feedbackVotes.unvote(otherScope, postId, 'user-1')).rejects.toBeInstanceOf(
      FeedbackPostNotFoundError,
    );
    await expect(feedback.feedbackVotes.list(otherScope, postId, page)).rejects.toBeInstanceOf(
      FeedbackPostNotFoundError,
    );
    expect(await voteCount()).toBe(0);
  });
});
