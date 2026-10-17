import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackDuplicateMethods } from '@mocco/common/feedback';
import { eq, isNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { DuplicatePolicy, keyWordsOf, titleOverlap } from '@backend/domain/feedback/DuplicateService';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, feedbackPosts, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';

const NOW = new Date('2026-10-17T12:00:00Z');

/** The outcome of a call: 'ok', or the error's class name. */
const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.name : 'unknown';
  }
};

describe('title matching', () => {
  it('leaves out filler words and scores the share of the newer title found in the other', () => {
    expect(keyWordsOf('Please add a dark mode for the timer')).toEqual(['dark', 'mode', 'timer']);
    expect(titleOverlap(['dark', 'mode', 'timer'], 'Dark mode!')).toEqual({ shared: 2, score: 2 / 3 });
    // Whole words only: "mode" is not in "model".
    expect(titleOverlap(['dark', 'mode'], 'Dark model export')).toEqual({ shared: 1, score: 0.5 });
    expect(titleOverlap([], 'Anything')).toEqual({ shared: 0, score: 0 });
  });
});

describe('suggested duplicates (pglite)', () => {
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

  const post = async (title: string, onBoard = boardId) =>
    await feedback.feedbackPosts.create(scope, actor, { boardId: onBoard, title });
  const queue = async () => await feedback.feedbackDuplicates.list(scope, boardId, 100);
  const pairsOf = async () => {
    const pairs = await queue();
    return pairs.map(pair => [pair.post.number, pair.original.number, pair.candidate.score] as const);
  };
  /** The open pair from post `from` to post `to`, by their numbers. */
  const pairOf = async (from: number, to: number) => {
    const pairs = await queue();
    return pairs.find(pair => pair.post.number === from && pair.original.number === to);
  };
  const linksOf = async () => {
    const pairs = await pairsOf();
    return pairs.map(([from, to]) => [from, to]);
  };

  it('pairs a new post with the older posts whose titles share its words, and checks each post once', async () => {
    await post('Dark mode for the timer screen');
    await post('Export to CSV');
    await post('Dark mode please');
    await post('Timer screen dark theme');

    expect(await feedback.feedbackDuplicates.detectDue()).toBe(4);
    // #3 has two key words (dark, mode), both in #1. #4's four key words share three with #1.
    expect(await pairsOf()).toEqual(
      expect.arrayContaining([
        [3, 1, 1],
        [4, 1, 0.75],
      ]),
    );
    expect(await pairsOf()).toHaveLength(2);
    const [pair] = await queue();
    expect(pair?.candidate.method).toBe(FeedbackDuplicateMethods.fulltext);
    expect(await feedback.feedbackDuplicates.countOpen(scope, boardId)).toBe(2);

    // Nothing is left to compare, so a second sweep adds nothing.
    const unchecked = await t.db.select().from(feedbackPosts).where(isNull(feedbackPosts.duplicatesCheckedAt));
    expect(unchecked).toEqual([]);
    expect(await feedback.feedbackDuplicates.detectDue()).toBe(0);
  });

  it('needs two shared key words covering half the title, and stays within the board', async () => {
    const other = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'bugs', name: 'Bugs' });
    await post('Dark mode for the timer', other.id);
    await post('Calendar sync with Google');
    await post('Calendar colors'); // one shared key word
    await post('Sync my Outlook calendar and contacts and reminders'); // 2 of 5 key words
    await post('Dark mode'); // its match is on another board

    await feedback.feedbackDuplicates.detectDue();
    expect(await pairsOf()).toEqual([]);
  });

  it('keeps at most a few pairs per post, the closest first', async () => {
    await post('Offline sync');
    await post('Offline sync for notes');
    await post('Offline sync for tasks');
    await post('Offline sync for photos');
    await post('Offline sync for notes, tasks and photos');

    await feedback.feedbackDuplicates.detectDue();
    const pairs = await queue();
    const fromLast = pairs.filter(pair => pair.post.number === 5);
    expect(fromLast).toHaveLength(DuplicatePolicy.pairsPerPost);
    expect(fromLast.map(pair => pair.original.number)).not.toContain(1);
  });

  it('drops a pair from the queue once either post is merged, and never suggests a dismissed pair again', async () => {
    const first = await post('Dark mode for the timer');
    await post('Timer dark mode');
    await post('Dark mode timer screen');
    await feedback.feedbackDuplicates.detectDue();
    expect(await pairsOf()).toHaveLength(3); // #2→#1, #3→#1, #3→#2

    const dismissed = await pairOf(3, 2);
    const toDismiss = dismissed?.candidate.id ?? '';
    await feedback.feedbackDuplicates.dismiss(scope, actor, toDismiss);
    expect(await outcome(async () => await feedback.feedbackDuplicates.dismiss(scope, actor, toDismiss))).toBe(
      'FeedbackDuplicateNotFoundError',
    );
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AuditActions.feedbackDuplicateDismissed));
    expect(audit).toHaveLength(1);

    // A sweep over the same posts again (as if they were never checked) keeps the dismissal.
    await t.db.update(feedbackPosts).set({ duplicatesCheckedAt: null });
    await feedback.feedbackDuplicates.detectDue();
    expect(await linksOf()).toEqual(
      expect.arrayContaining([
        [2, 1],
        [3, 1],
      ]),
    );
    expect(await pairsOf()).toHaveLength(2);

    const second = await pairOf(2, 1);
    await feedback.feedbackMerges.merge(scope, actor, second?.post.id ?? '', first.id);
    expect(await linksOf()).toEqual([[3, 1]]);
  });

  it("doesn't see another project's pairs or dismiss them", async () => {
    await post('Dark mode for the timer');
    await post('Timer dark mode');
    await feedback.feedbackDuplicates.detectDue();
    const [pair] = await queue();
    const elsewhere = { workspaceId: scope.workspaceId, projectId: randomUUID() };
    expect(await outcome(async () => await feedback.feedbackDuplicates.list(elsewhere, boardId, 100))).toBe(
      'FeedbackBoardNotFoundError',
    );
    expect(
      await outcome(async () => await feedback.feedbackDuplicates.dismiss(elsewhere, actor, pair?.candidate.id ?? '')),
    ).toBe('FeedbackDuplicateNotFoundError');
  });
});
