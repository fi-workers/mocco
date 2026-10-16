import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ChangelogEntryStates, ChangelogTags } from '@mocco/common/feedback';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { changelogSlugOf } from '@backend/domain/feedback/ChangelogService';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import {
  ChangelogEntryNotFoundError,
  ChangelogEntryStateError,
  ChangelogPostsInvalidError,
  ChangelogPublishAtPastError,
  FeedbackBoardNotFoundError,
  FeedbackSlugTakenError,
} from '@backend/domain/feedback/errors';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, changelogEntryPosts, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';

const T0 = new Date('2026-10-16T09:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('changelog entries (pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let otherScope: FeedbackScope;
  let actor: string;
  let clock: Date;
  let boardId: string;

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    feedback = createFeedbackDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      now: () => clock,
    });
    const workspace = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning());
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const { projects } = createProjectDomain(t.db);
    const project = await projects.create(workspace.id, { name: 'Acme', handle: 'acme' });
    const other = await projects.create(workspace.id, { name: 'Other', handle: 'other' });
    scope = { workspaceId: workspace.id, projectId: project.id };
    otherScope = { workspaceId: workspace.id, projectId: other.id };
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    boardId = board.id;
  });
  afterEach(async () => {
    await t.close();
  });

  const post = async (title: string, onBoard = boardId) =>
    await feedback.feedbackPosts.create(scope, actor, { boardId: onBoard, title });

  const auditActions = async () => {
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.workspaceId, scope.workspaceId));
    return rows.map(row => [row.action, row.actorUserId]);
  };

  it('makes addresses from titles, keeps them free on the board, and refuses a taken one', async () => {
    expect(changelogSlugOf('Dark mode is here!')).toBe('dark-mode-is-here');
    expect(changelogSlugOf('다크 모드')).toBe('');
    const first = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'Dark mode is here!' });
    const second = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'Dark mode is here' });
    const untitled = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: '다크 모드' });
    expect([first.slug, second.slug, untitled.slug]).toEqual([
      'dark-mode-is-here',
      'dark-mode-is-here-2',
      '2026-10-16',
    ]);
    expect(first).toMatchObject({ state: ChangelogEntryStates.draft, publishAt: null, publishedAt: null });
    await expect(
      feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'x', slug: 'dark-mode-is-here' }),
    ).rejects.toBeInstanceOf(FeedbackSlugTakenError);
    await expect(
      feedback.feedbackChangelog.update(scope, second.id, { slug: 'dark-mode-is-here' }),
    ).rejects.toBeInstanceOf(FeedbackSlugTakenError);
  });

  it('announces live posts of its own board only, in order, and edits replace the lists', async () => {
    const a = await post('A');
    const b = await post('B');
    const duplicate = await post('Same as A');
    await feedback.feedbackMerges.merge(scope, actor, duplicate.id, a.id);
    const otherBoard = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'bugs', name: 'Bugs' });
    const elsewhere = await post('Elsewhere', otherBoard.id);

    const entry = await feedback.feedbackChangelog.create(scope, actor, {
      boardId,
      title: 'October',
      tags: [ChangelogTags.new, ChangelogTags.fixed, ChangelogTags.new],
      postIds: [b.id, a.id, b.id],
    });
    expect(entry).toMatchObject({ postIds: [b.id, a.id], tags: ['new', 'fixed'] });
    await expect(
      feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'x', postIds: [a.id, elsewhere.id] }),
    ).rejects.toBeInstanceOf(ChangelogPostsInvalidError);
    await expect(
      feedback.feedbackChangelog.update(scope, entry.id, { postIds: [duplicate.id] }),
    ).rejects.toBeInstanceOf(ChangelogPostsInvalidError);

    const edited = await feedback.feedbackChangelog.update(scope, entry.id, {
      title: 'October update',
      body: 'Two things shipped.',
      tags: [ChangelogTags.improved],
      postIds: [a.id],
    });
    expect(edited).toMatchObject({
      title: 'October update',
      bodyMd: 'Two things shipped.',
      tags: ['improved'],
      postIds: [a.id],
      slug: 'october',
    });
    // Deleting a post removes it from the entry.
    await t.db.delete(changelogEntryPosts).where(eq(changelogEntryPosts.postId, a.id));
    const unlinked = await feedback.feedbackChangelog.get(scope, entry.id);
    expect(unlinked.postIds).toEqual([]);
  });

  it('publishes, unpublishes and deletes with an audit trail, and refuses the wrong state', async () => {
    const entry = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'Launch' });
    await expect(feedback.feedbackChangelog.unpublish(scope, actor, entry.id)).rejects.toBeInstanceOf(
      ChangelogEntryStateError,
    );
    const published = await feedback.feedbackChangelog.publish(scope, actor, entry.id);
    expect(published).toMatchObject({ state: ChangelogEntryStates.published, publishedAt: T0, publishAt: null });
    await expect(feedback.feedbackChangelog.publish(scope, actor, entry.id)).rejects.toBeInstanceOf(
      ChangelogEntryStateError,
    );
    await expect(feedback.feedbackChangelog.schedule(scope, entry.id, minutes(5))).rejects.toBeInstanceOf(
      ChangelogEntryStateError,
    );
    const draft = await feedback.feedbackChangelog.unpublish(scope, actor, entry.id);
    expect(draft).toMatchObject({ state: ChangelogEntryStates.draft, publishedAt: null });
    await feedback.feedbackChangelog.delete(scope, actor, entry.id);
    await expect(feedback.feedbackChangelog.get(scope, entry.id)).rejects.toBeInstanceOf(ChangelogEntryNotFoundError);
    expect(await auditActions()).toEqual(
      expect.arrayContaining([
        [AuditActions.changelogEntryPublished, actor],
        [AuditActions.changelogEntryUnpublished, actor],
        [AuditActions.changelogEntryDeleted, actor],
      ]),
    );
  });

  it('publishes a scheduled entry once its time comes, as of that time, exactly once', async () => {
    const entry = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'Soon' });
    await expect(feedback.feedbackChangelog.schedule(scope, entry.id, T0)).rejects.toBeInstanceOf(
      ChangelogPublishAtPastError,
    );
    const scheduled = await feedback.feedbackChangelog.schedule(scope, entry.id, minutes(10));
    expect(scheduled).toMatchObject({ state: ChangelogEntryStates.scheduled, publishAt: minutes(10) });

    clock = minutes(9);
    expect(await feedback.feedbackChangelog.publishDue()).toBe(0);
    clock = minutes(11);
    expect(await feedback.feedbackChangelog.publishDue()).toBe(1);
    expect(await feedback.feedbackChangelog.publishDue()).toBe(0);
    expect(await feedback.feedbackChangelog.get(scope, entry.id)).toMatchObject({
      state: ChangelogEntryStates.published,
      publishedAt: minutes(10),
      publishAt: null,
    });
    // The job publishes with no actor.
    expect(await auditActions()).toEqual([
      [AuditActions.feedbackBoardCreated, actor],
      [AuditActions.changelogEntryPublished, null],
    ]);

    // Unscheduling takes it back to a draft without an audit row.
    const later = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'Later' });
    await feedback.feedbackChangelog.schedule(scope, later.id, minutes(60));
    expect(await feedback.feedbackChangelog.unpublish(scope, actor, later.id)).toMatchObject({
      state: ChangelogEntryStates.draft,
      publishAt: null,
    });
    clock = minutes(61);
    expect(await feedback.feedbackChangelog.publishDue()).toBe(0);
  });

  it("lists a board's entries newest first, filters by state, and keeps other projects out", async () => {
    const old = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'Old' });
    await feedback.feedbackChangelog.publish(scope, actor, old.id);
    clock = minutes(5);
    const fresh = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'Fresh' });
    await feedback.feedbackChangelog.publish(scope, actor, fresh.id);
    const draft = await feedback.feedbackChangelog.create(scope, actor, { boardId, title: 'Draft' });
    await feedback.feedbackChangelog.schedule(scope, draft.id, minutes(60));

    const all = await feedback.feedbackChangelog.list(scope, { boardId, limit: 50, offset: 0 });
    expect(all.map(entry => entry.title)).toEqual(['Draft', 'Fresh', 'Old']);
    const published = await feedback.feedbackChangelog.list(scope, {
      boardId,
      state: ChangelogEntryStates.published,
      limit: 50,
      offset: 0,
    });
    expect(published.map(entry => entry.title)).toEqual(['Fresh', 'Old']);

    await expect(feedback.feedbackChangelog.list(otherScope, { boardId, limit: 50, offset: 0 })).rejects.toBeInstanceOf(
      FeedbackBoardNotFoundError,
    );
    await expect(feedback.feedbackChangelog.get(otherScope, old.id)).rejects.toBeInstanceOf(
      ChangelogEntryNotFoundError,
    );
    await expect(feedback.feedbackChangelog.publish(otherScope, actor, draft.id)).rejects.toBeInstanceOf(
      ChangelogEntryNotFoundError,
    );
    await expect(feedback.feedbackChangelog.create(otherScope, actor, { boardId, title: 'x' })).rejects.toBeInstanceOf(
      FeedbackBoardNotFoundError,
    );
    // Deleting the board deletes its entries.
    await feedback.feedbackBoards.deleteBoard(scope, actor, boardId);
    await expect(feedback.feedbackChangelog.get(scope, old.id)).rejects.toBeInstanceOf(ChangelogEntryNotFoundError);
  });
});
