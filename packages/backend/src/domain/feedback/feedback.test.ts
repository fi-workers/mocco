import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackPostSorts, FeedbackPostStatuses, FeedbackStatusChangeReasons } from '@mocco/common/feedback';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import {
  FeedbackBoardNotFoundError,
  FeedbackCategoryNotFoundError,
  FeedbackPostNotFoundError,
  FeedbackSlugTakenError,
  FeedbackStatusMovedError,
  FeedbackStatusUnchangedError,
} from '@backend/domain/feedback/errors';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { FeedbackPostStatus } from '@mocco/common/feedback';

const SHIPPED_AT = new Date('2026-10-06T12:00:00Z');

const listQuery = (boardId: string) => ({ boardId, sort: FeedbackPostSorts.status, limit: 50, offset: 0 });

describe('feedback boards and posts (pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let actor: string;

  beforeEach(async () => {
    t = await createTestDb();
    feedback = createFeedbackDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      now: () => SHIPPED_AT,
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
  });
  afterEach(async () => {
    await t.close();
  });

  it('creates a board and categories; slugs are unique per project and per board', async () => {
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    const mobile = await feedback.feedbackBoards.createCategory(scope, board.id, { slug: 'mobile', name: 'Mobile' });
    const api = await feedback.feedbackBoards.createCategory(scope, board.id, { slug: 'api', name: 'API' });

    const detail = await feedback.feedbackBoards.getBoard(scope, board.id);
    expect(detail.board).toMatchObject({ slug: 'ideas', name: 'Ideas', isPublic: true });
    expect(detail.categories.map(row => [row.slug, row.position])).toEqual([
      ['mobile', 0],
      ['api', 1],
    ]);
    expect([mobile.boardId, api.boardId]).toEqual([board.id, board.id]);
    await expect(
      feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Again' }),
    ).rejects.toBeInstanceOf(FeedbackSlugTakenError);
    await expect(
      feedback.feedbackBoards.createCategory(scope, board.id, { slug: 'api', name: 'Again' }),
    ).rejects.toBeInstanceOf(FeedbackSlugTakenError);
    // Another project of the workspace may use the same slug.
    const other = await createProjectDomain(t.db).projects.create(scope.workspaceId, { name: 'B', handle: 'b' });
    await feedback.feedbackBoards.createBoard({ ...scope, projectId: other.id }, actor, { slug: 'ideas', name: 'B' });
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.subjectType, 'feedback_board'));
    expect(audit.map(row => row.action)).toEqual([
      AuditActions.feedbackBoardCreated,
      AuditActions.feedbackBoardCreated,
    ]);
  });

  it('numbers posts per board and records the first status as created', async () => {
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    const second = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'bugs', name: 'Bugs' });
    const category = await feedback.feedbackBoards.createCategory(scope, board.id, { slug: 'mobile', name: 'Mobile' });

    const first = await feedback.feedbackPosts.create(scope, actor, {
      boardId: board.id,
      title: 'Dark mode',
      body: 'Please',
      categoryId: category.id,
    });
    const shipped = await feedback.feedbackPosts.create(scope, actor, {
      boardId: board.id,
      title: 'Export CSV',
      status: FeedbackPostStatuses.shipped,
    });
    const other = await feedback.feedbackPosts.create(scope, actor, { boardId: second.id, title: 'Crash' });

    expect([first.number, shipped.number, other.number]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({
      status: FeedbackPostStatuses.underReview,
      categoryId: category.id,
      body: 'Please',
      shippedAt: null,
      authorUserId: actor,
    });
    expect(shipped).toMatchObject({ status: FeedbackPostStatuses.shipped, body: '', shippedAt: SHIPPED_AT });
    const { history } = await feedback.feedbackPosts.get(scope, first.id);
    expect(history).toEqual([
      expect.objectContaining({
        fromStatus: null,
        toStatus: FeedbackPostStatuses.underReview,
        reason: FeedbackStatusChangeReasons.created,
        actorUserId: actor,
      }),
    ]);
    // A category of another board is not this board's.
    const foreign = await feedback.feedbackBoards.createCategory(scope, second.id, { slug: 'ios', name: 'iOS' });
    await expect(
      feedback.feedbackPosts.create(scope, actor, { boardId: board.id, title: 'x', categoryId: foreign.id }),
    ).rejects.toBeInstanceOf(FeedbackCategoryNotFoundError);
    await expect(feedback.feedbackPosts.update(scope, first.id, { categoryId: foreign.id })).rejects.toBeInstanceOf(
      FeedbackCategoryNotFoundError,
    );
    await expect(
      feedback.feedbackPosts.create(scope, actor, { boardId: randomUUID(), title: 'x' }),
    ).rejects.toBeInstanceOf(FeedbackBoardNotFoundError);
  });

  it('lists a board sorted by status in workflow order, newest first within a status, or by date', async () => {
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    const statuses: [string, FeedbackPostStatus][] = [
      ['a', FeedbackPostStatuses.closed],
      ['b', FeedbackPostStatuses.planned],
      ['c', FeedbackPostStatuses.underReview],
      ['d', FeedbackPostStatuses.shipped],
      ['e', FeedbackPostStatuses.planned],
      ['f', FeedbackPostStatuses.inProgress],
      ['g', FeedbackPostStatuses.underReview],
    ];
    // One at a time, so each post is newer than the one before.
    await statuses.reduce(async (previous, [title, status]) => {
      await previous;
      await feedback.feedbackPosts.create(scope, actor, { boardId: board.id, title, status });
    }, Promise.resolve());

    const byStatus = await feedback.feedbackPosts.list(scope, listQuery(board.id));
    expect(byStatus.map(post => post.title)).toEqual(['g', 'c', 'e', 'b', 'f', 'd', 'a']);
    const newest = await feedback.feedbackPosts.list(scope, { ...listQuery(board.id), sort: FeedbackPostSorts.newest });
    expect(newest.map(post => post.title)).toEqual(['g', 'f', 'e', 'd', 'c', 'b', 'a']);
    const planned = await feedback.feedbackPosts.list(scope, {
      ...listQuery(board.id),
      status: FeedbackPostStatuses.planned,
    });
    expect(planned.map(post => post.title)).toEqual(['e', 'b']);
    const page = await feedback.feedbackPosts.list(scope, { ...listQuery(board.id), limit: 2, offset: 2 });
    expect(page.map(post => post.title)).toEqual(['e', 'b']);
    await expect(feedback.feedbackPosts.list(scope, listQuery(randomUUID()))).rejects.toBeInstanceOf(
      FeedbackBoardNotFoundError,
    );
  });

  it('records every status change in the history and the audit log, and keeps shippedAt in step', async () => {
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    const post = await feedback.feedbackPosts.create(scope, actor, { boardId: board.id, title: 'Dark mode' });

    const planned = await feedback.feedbackPosts.setStatus(scope, actor, post.id, FeedbackPostStatuses.planned);
    expect(planned.change).toMatchObject({
      fromStatus: FeedbackPostStatuses.underReview,
      toStatus: FeedbackPostStatuses.planned,
      reason: FeedbackStatusChangeReasons.manual,
    });
    const shipped = await feedback.feedbackPosts.setStatus(scope, actor, post.id, FeedbackPostStatuses.shipped);
    expect(shipped.post).toMatchObject({ status: FeedbackPostStatuses.shipped, shippedAt: SHIPPED_AT });
    // Reopening a shipped post clears when it shipped.
    const reopened = await feedback.feedbackPosts.setStatus(scope, actor, post.id, FeedbackPostStatuses.inProgress);
    expect(reopened.post).toMatchObject({ status: FeedbackPostStatuses.inProgress, shippedAt: null });
    await expect(
      feedback.feedbackPosts.setStatus(scope, actor, post.id, FeedbackPostStatuses.inProgress),
    ).rejects.toBeInstanceOf(FeedbackStatusUnchangedError);
    await expect(
      feedback.feedbackPosts.setStatus(scope, actor, randomUUID(), FeedbackPostStatuses.closed),
    ).rejects.toBeInstanceOf(FeedbackPostNotFoundError);

    const { history } = await feedback.feedbackPosts.get(scope, post.id);
    expect(history.map(row => [row.fromStatus, row.toStatus, row.reason])).toEqual([
      [null, FeedbackPostStatuses.underReview, FeedbackStatusChangeReasons.created],
      [FeedbackPostStatuses.underReview, FeedbackPostStatuses.planned, FeedbackStatusChangeReasons.manual],
      [FeedbackPostStatuses.planned, FeedbackPostStatuses.shipped, FeedbackStatusChangeReasons.manual],
      [FeedbackPostStatuses.shipped, FeedbackPostStatuses.inProgress, FeedbackStatusChangeReasons.manual],
    ]);
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.subjectId, post.id));
    expect(audit.map(row => [row.action, row.payload])).toEqual([
      [
        AuditActions.feedbackPostStatusChanged,
        expect.objectContaining({ from: FeedbackPostStatuses.underReview, to: FeedbackPostStatuses.planned }),
      ],
      [
        AuditActions.feedbackPostStatusChanged,
        expect.objectContaining({ from: FeedbackPostStatuses.planned, to: FeedbackPostStatuses.shipped }),
      ],
      [
        AuditActions.feedbackPostStatusChanged,
        expect.objectContaining({ from: FeedbackPostStatuses.shipped, to: FeedbackPostStatuses.inProgress }),
      ],
    ]);
  });

  it('applies a change asked from a status only while the post is still in it', async () => {
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    const post = await feedback.feedbackPosts.create(scope, actor, { boardId: board.id, title: 'Dark mode' });
    await feedback.feedbackPosts.setStatus(scope, actor, post.id, FeedbackPostStatuses.planned);

    await expect(
      feedback.feedbackPosts.setStatus(scope, actor, post.id, FeedbackPostStatuses.shipped, {
        from: FeedbackPostStatuses.underReview,
      }),
    ).rejects.toBeInstanceOf(FeedbackStatusMovedError);
    const moved = await feedback.feedbackPosts.setStatus(scope, actor, post.id, FeedbackPostStatuses.shipped, {
      from: FeedbackPostStatuses.planned,
    });

    expect(moved.change).toMatchObject({ fromStatus: FeedbackPostStatuses.planned });
    const { history } = await feedback.feedbackPosts.get(scope, post.id);
    expect(history).toHaveLength(3);
  });

  it('edits a post, uncategorizes posts when their category is deleted, and deletes a board with its posts', async () => {
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    const category = await feedback.feedbackBoards.createCategory(scope, board.id, { slug: 'mobile', name: 'Mobile' });
    const post = await feedback.feedbackPosts.create(scope, actor, { boardId: board.id, title: 'Dark mode' });

    const edited = await feedback.feedbackPosts.update(scope, post.id, {
      title: 'Dark theme',
      categoryId: category.id,
    });
    expect(edited).toMatchObject({ title: 'Dark theme', body: '', categoryId: category.id });
    await feedback.feedbackBoards.deleteCategory(scope, category.id);
    const uncategorized = await feedback.feedbackPosts.requirePost(scope, post.id);
    expect(uncategorized.categoryId).toBeNull();
    await expect(feedback.feedbackBoards.deleteCategory(scope, category.id)).rejects.toBeInstanceOf(
      FeedbackCategoryNotFoundError,
    );

    await feedback.feedbackBoards.deleteBoard(scope, actor, board.id);
    await expect(feedback.feedbackPosts.get(scope, post.id)).rejects.toBeInstanceOf(FeedbackPostNotFoundError);
    expect(await feedback.feedbackBoards.listBoards(scope)).toEqual([]);
  });
});
