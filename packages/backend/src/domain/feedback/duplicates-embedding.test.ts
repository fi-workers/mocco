import { randomUUID } from 'node:crypto';

import { FeedbackDuplicateMethods } from '@mocco/common/feedback';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import {
  contentHashOf,
  DuplicatePolicy,
  DuplicateService,
  unitLength,
} from '@backend/domain/feedback/DuplicateService';
import { FakeEmbedder } from '@backend/domain/feedback/embed/testing/fake-embedder';
import { FeedbackPostEmbeddingRepo } from '@backend/domain/feedback/repos/post-embedding.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { feedbackPostEmbeddings, feedbackPosts, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { Embedder } from '@backend/domain/feedback/embed/Embedder';
import type { FeedbackScope } from '@backend/domain/feedback/scope';

const NOW = new Date('2026-10-17T12:00:00Z');

/** What a text is about, as the fake's vector: titles with no word in common can mean the same. */
const topicOf = (text: string): number[] => {
  if (/dark|night/iu.test(text)) {
    return [3, 0, 0];
  }
  if (/export|spreadsheet/iu.test(text)) {
    return [0, 4, 0];
  }
  return [0, 0, 1];
};

describe('embedding helpers', () => {
  it('scales a vector to length 1 and leaves all zeros alone', () => {
    expect(unitLength([3, 4])).toEqual([0.6, 0.8]);
    expect(unitLength([0, 0])).toEqual([0, 0]);
  });
});

describe('suggested duplicates by meaning (pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let audit: AuditService;
  let scope: FeedbackScope;
  let actor: string;
  let boardId: string;

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    feedback = createFeedbackDomain(t.db, { audit, now: () => NOW });
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

  const sweeper = (embedder?: Embedder) =>
    new DuplicateService({
      db: t.db,
      audit,
      boards: feedback.feedbackBoards,
      ...(embedder !== undefined && { embedder }),
      now: () => NOW,
    });
  const post = async (title: string, body?: string) =>
    await feedback.feedbackPosts.create(scope, actor, { boardId, title, ...(body !== undefined && { body }) });
  const pairsOf = async () => {
    const pairs = await feedback.feedbackDuplicates.list(scope, boardId, 100);
    return pairs
      .map(pair => [pair.post.number, pair.original.number, pair.candidate.method] as const)
      .toSorted((left, right) => left[0] - right[0] || left[1] - right[1]);
  };
  const embeddings = async () => await t.db.select().from(feedbackPostEmbeddings);

  it('pairs posts that mean the same with no title words in common, in one call to the embedder', async () => {
    await post('Dark mode for the café timer', 'My eyes hurt at night.');
    await post('Export to CSV');
    await post('Night theme');
    await post('Download a spreadsheet of my data');
    await post('Calendar sync with Google');

    const embedder = new FakeEmbedder({ vectorOf: topicOf });
    expect(await sweeper(embedder).detectDue()).toBe(5);

    expect(embedder.calls).toHaveLength(1);
    expect(embedder.sent[0]).toBe('Dark mode for the café timer\n\nMy eyes hurt at night.');
    expect(await pairsOf()).toEqual([
      [3, 1, FeedbackDuplicateMethods.embedding],
      [4, 2, FeedbackDuplicateMethods.embedding],
    ]);
    const [pair] = await feedback.feedbackDuplicates.list(scope, boardId, 100);
    expect(pair?.candidate.score).toBeCloseTo(1);

    const rows = await embeddings();
    expect(rows).toHaveLength(5);
    const first = rows.find(row => row.dims === 3 && row.embedding[0] === 1);
    expect(first).toMatchObject({ model: 'fake-embedding', workspaceId: scope.workspaceId });
  });

  it('keeps a pair the title words found as full text, one row per pair, and adds what they missed', async () => {
    await post('Dark mode for the timer');
    await post('Timer dark mode');
    await post('Night colors');

    await sweeper(new FakeEmbedder({ vectorOf: topicOf })).detectDue();
    expect(await pairsOf()).toEqual([
      [2, 1, FeedbackDuplicateMethods.fulltext],
      [3, 1, FeedbackDuplicateMethods.embedding],
      [3, 2, FeedbackDuplicateMethods.embedding],
    ]);
  });

  it('embeds a post once, again when its words or the model change, and never a merged post', async () => {
    const first = await post('Dark mode for the café timer');
    const second = await post('Night theme');
    const merged = await post('Black theme');
    await feedback.feedbackMerges.merge(scope, actor, merged.id, second.id);

    const embedder = new FakeEmbedder();
    await sweeper(embedder).detectDue();
    expect(embedder.sent).toHaveLength(2);
    // The hash the service stores is the one the repo computes in SQL: nothing is due again.
    const stored = await new FeedbackPostEmbeddingRepo(t.db).find(first.id);
    expect(stored?.contentHash).toBe(contentHashOf(first));
    await sweeper(embedder).detectDue();
    expect(embedder.calls).toHaveLength(1);

    await feedback.feedbackPosts.update(scope, first.id, { body: 'At night too.' });
    await sweeper(embedder).detectDue();
    expect(embedder.calls[1]).toEqual(['Dark mode for the café timer\n\nAt night too.']);

    const next = new FakeEmbedder({ model: 'fake-embedding-2' });
    await sweeper(next).detectDue();
    expect(next.sent).toHaveLength(2);
    const rows = await embeddings();
    expect(new Set(rows.map(row => row.model))).toEqual(new Set(['fake-embedding-2']));
  });

  it('embeds the posts about to be compared first, within the budget', async () => {
    const older = await post('Export to CSV');
    await t.db.update(feedbackPosts).set({ duplicatesCheckedAt: NOW });
    const newer = await post('Night theme');

    const due = await new FeedbackPostEmbeddingRepo(t.db).due('fake-embedding', 1);
    expect(due.map(row => row.id)).toEqual([newer.id]);
    const both = await new FeedbackPostEmbeddingRepo(t.db).due('fake-embedding', 5);
    expect(both.map(row => row.id)).toEqual([newer.id, older.id]);
  });

  it("doesn't compare vectors from another model, or pair posts that aren't alike enough", async () => {
    await post('Dark mode');
    await sweeper(new FakeEmbedder({ model: 'old-model', vectorOf: topicOf })).detectDue();
    const night = await post('Night theme');
    const calendar = await post('Calendar sync with Google');
    const repo = new FeedbackPostEmbeddingRepo(t.db);
    // #1 is due again for a new model; #2 and #3 get their new-model vectors first.
    expect(await repo.due('new-model', 10)).toHaveLength(3);
    await repo.upsertMany(
      [night, calendar].map(row => ({
        postId: row.id,
        workspaceId: row.workspaceId,
        model: 'new-model',
        dims: 3,
        embedding: unitLength(topicOf(row.title)),
        contentHash: contentHashOf(row),
      })),
    );

    // #2 means what #1 does, but #1's vector is old-model's.
    expect(await repo.nearestOlder(night, 'new-model', { minScore: 0.8, limit: 3 })).toEqual([]);
    expect(await repo.nearestOlder(calendar, 'new-model', { minScore: 0, limit: 3 })).toEqual([
      { post: expect.objectContaining({ id: night.id }), score: 0 },
    ]);
    expect(await repo.nearestOlder(calendar, 'new-model', { minScore: 0.8, limit: 3 })).toEqual([]);
  });

  it('falls back to title words when the embedder fails, and embeds on a later sweep', async () => {
    await post('Dark mode for the timer');
    await post('Timer dark mode');
    await post('Night colors');

    await sweeper(new FakeEmbedder({ failWith: new Error('503') })).detectDue();
    expect(await pairsOf()).toEqual([[2, 1, FeedbackDuplicateMethods.fulltext]]);
    expect(await embeddings()).toEqual([]);

    await sweeper(new FakeEmbedder({ vectorOf: topicOf })).detectDue();
    expect(await embeddings()).toHaveLength(3);
  });

  it('leaves the posts past the time budget to the next sweep, which gets through at least one', async () => {
    await post('Dark mode for the timer');
    await post('Timer dark mode');
    await post('Night colors');
    const clock = { at: NOW.getTime() };
    const slow = new DuplicateService({
      db: t.db,
      audit,
      boards: feedback.feedbackBoards,
      embedder: new FakeEmbedder({ vectorOf: topicOf }),
      now: () => {
        clock.at += DuplicatePolicy.sweepBudgetMs;
        return new Date(clock.at);
      },
    });

    expect(await slow.detectDue()).toBe(2);
    expect(await slow.detectDue()).toBe(1);
    expect(await slow.detectDue()).toBe(0);
    expect(await pairsOf()).toEqual([
      [2, 1, FeedbackDuplicateMethods.fulltext],
      [3, 1, FeedbackDuplicateMethods.embedding],
      [3, 2, FeedbackDuplicateMethods.embedding],
    ]);
  });

  it('matches by title words only without an embedder', async () => {
    await post('Dark mode for the timer');
    await post('Night theme');
    await post('Timer dark mode');

    expect(await feedback.feedbackDuplicates.detectDue()).toBe(3);
    expect(await pairsOf()).toEqual([[3, 1, FeedbackDuplicateMethods.fulltext]]);
    expect(await embeddings()).toEqual([]);
  });
});
