import { randomUUID } from 'node:crypto';

import { FeedbackCommentAuthorKinds } from '@mocco/common/feedback';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { FeedbackOfficialInternalError, FeedbackPostNotFoundError } from '@backend/domain/feedback/errors';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { feedbackComments, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';

const page = { limit: 100, offset: 0 };
const plain = { isOfficial: false, isInternal: false };

describe('feedback comments (pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let actor: string;
  let postId: string;

  beforeEach(async () => {
    t = await createTestDb();
    feedback = createFeedbackDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }) });
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

  const commentCount = async () => {
    const post = await feedback.feedbackPosts.requirePost(scope, postId);
    return post.commentCount;
  };

  /** An end user's comment, the official response and an internal note, in that order. */
  const writeThree = async () => {
    await feedback.feedbackComments.createAsEndUser(scope, postId, 'user-1', 'Me too');
    await feedback.feedbackComments.createAsStaff(scope, actor, postId, {
      ...plain,
      body: 'Planned for Q4',
      isOfficial: true,
    });
    await feedback.feedbackComments.createAsStaff(scope, actor, postId, {
      ...plain,
      body: 'Blocked on the theming work',
      isInternal: true,
    });
  };

  it('shows the team every comment, the official response flagged and internal notes included', async () => {
    await writeThree();
    const comments = await feedback.feedbackComments.listForStaff(scope, postId, page);
    expect(comments.map(row => [row.authorKind, row.body, row.isOfficial, row.isInternal])).toEqual([
      [FeedbackCommentAuthorKinds.endUser, 'Me too', false, false],
      [FeedbackCommentAuthorKinds.staff, 'Planned for Q4', true, false],
      [FeedbackCommentAuthorKinds.staff, 'Blocked on the theming work', false, true],
    ]);
    expect(comments.map(row => [row.authorUserId, row.authorEndUserId])).toEqual([
      [null, 'user-1'],
      [actor, null],
      [actor, null],
    ]);
  });

  it('keeps internal notes and staff ids out of the public projection, and counts only public comments', async () => {
    await writeThree();
    const visible = await feedback.feedbackComments.listForPublic(scope, postId, page);
    expect(visible).toEqual([
      {
        id: expect.any(String),
        authorKind: FeedbackCommentAuthorKinds.endUser,
        authorEndUserId: 'user-1',
        body: 'Me too',
        isOfficial: false,
        createdAt: expect.any(Date),
      },
      {
        id: expect.any(String),
        authorKind: FeedbackCommentAuthorKinds.staff,
        authorEndUserId: null,
        body: 'Planned for Q4',
        isOfficial: true,
        createdAt: expect.any(Date),
      },
    ]);
    expect(JSON.stringify(visible)).not.toContain(actor);
    expect(await commentCount()).toBe(2);
  });

  it('refuses an official internal note, in the service and in the database', async () => {
    await expect(
      feedback.feedbackComments.createAsStaff(scope, actor, postId, {
        body: 'x',
        isOfficial: true,
        isInternal: true,
      }),
    ).rejects.toBeInstanceOf(FeedbackOfficialInternalError);
    // An end user's comment can't be official or internal, nor carry a team member.
    await expect(
      t.db.insert(feedbackComments).values({
        workspaceId: scope.workspaceId,
        postId,
        authorKind: FeedbackCommentAuthorKinds.endUser,
        authorEndUserId: 'user-1',
        body: 'x',
        isOfficial: true,
      }),
    ).rejects.toThrow();
    await expect(
      t.db.insert(feedbackComments).values({
        workspaceId: scope.workspaceId,
        postId,
        authorKind: FeedbackCommentAuthorKinds.staff,
        authorUserId: actor,
        authorEndUserId: 'user-1',
        body: 'x',
      }),
    ).rejects.toThrow();
    expect(await feedback.feedbackComments.listForStaff(scope, postId, page)).toEqual([]);
    expect(await commentCount()).toBe(0);
  });

  it("refuses another project's post", async () => {
    const other = await createProjectDomain(t.db).projects.create(scope.workspaceId, { name: 'B', handle: 'b' });
    const otherScope = { ...scope, projectId: other.id };
    await expect(
      feedback.feedbackComments.createAsStaff(otherScope, actor, postId, { ...plain, body: 'x' }),
    ).rejects.toBeInstanceOf(FeedbackPostNotFoundError);
    await expect(feedback.feedbackComments.createAsEndUser(otherScope, postId, 'user-1', 'x')).rejects.toBeInstanceOf(
      FeedbackPostNotFoundError,
    );
    await expect(feedback.feedbackComments.listForPublic(otherScope, postId, page)).rejects.toBeInstanceOf(
      FeedbackPostNotFoundError,
    );
  });
});
