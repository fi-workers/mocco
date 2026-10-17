import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackSourceTypes, FeedbackVoteSources, feedbackPostListInputSchema } from '@mocco/common/feedback';
import { AuthorKinds, ConversationStatuses, MessageVisibilities } from '@mocco/common/messenger';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { eraseContact } from '@backend/domain/messenger/erase';
import { firstLine, messengerFeedbackSource } from '@backend/domain/messenger/feedback-source';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  messengerContacts,
  messengerConversations,
  messengerMessages,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';

const NOW = new Date('2026-10-17T12:00:00Z');
const source = FeedbackSourceTypes.messengerConversation;

/** The outcome of a call: 'ok', or the error's class name. */
const outcome = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.name : 'unknown';
  }
};

describe('firstLine', () => {
  it('keeps the first line and shortens it at a word', () => {
    expect(firstLine('  Dark mode please\nIt hurts at night', 80)).toBe('Dark mode please');
    expect(firstLine('Please let me export every session I ever recorded', 30)).toBe('Please let me export every…');
    expect(firstLine('', 30)).toBe('');
  });
});

describe('converting a messenger conversation to feedback (pglite)', () => {
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
      sources: { [source]: messengerFeedbackSource(t.db) },
    });
    const workspace = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning());
    const user = await t.db
      .insert(users)
      .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
      .returning();
    actor = expectOne(user).id;
    const project = await createProjectDomain(t.db).projects.create(workspace.id, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId: workspace.id, projectId: project.id };
    const board = await feedback.feedbackBoards.createBoard(scope, actor, { slug: 'ideas', name: 'Ideas' });
    boardId = board.id;
  });
  afterEach(async () => {
    await t.close();
  });

  /** A conversation the contact started with `lines`; a guest when `externalUserId` is null. */
  const conversation = async (externalUserId: string | null, lines: string[]) => {
    const contact = await t.db
      .insert(messengerContacts)
      .values({
        ...scope,
        externalUserId,
        ...(externalUserId === null && { email: 'guest@example.com', guestTokenHash: randomUUID() }),
        lastSeenAt: NOW,
      })
      .returning();
    const conv = await t.db
      .insert(messengerConversations)
      .values({
        ...scope,
        contactId: expectOne(contact).id,
        status: ConversationStatuses.open,
        lastMessageAt: NOW,
        preview: lines[0] ?? '',
      })
      .returning();
    const conversationId = expectOne(conv).id;
    await t.db.insert(messengerMessages).values([
      ...lines.map((body, index) => ({
        workspaceId: scope.workspaceId,
        conversationId,
        seq: index * 2 + 1,
        authorKind: AuthorKinds.contact,
        visibility: MessageVisibilities.public,
        body,
      })),
      {
        workspaceId: scope.workspaceId,
        conversationId,
        seq: 100,
        authorKind: AuthorKinds.operator,
        authorUserId: actor,
        visibility: MessageVisibilities.internal,
        body: 'Internal: this customer is on the big plan',
      },
    ]);
    return conversationId;
  };

  it('previews the request from what the contact wrote, never the internal notes', async () => {
    await feedback.feedbackPosts.create(scope, actor, { boardId, title: 'Dark mode for the timer' });
    const id = await conversation('user-ada', ['Dark mode please', 'The timer screen is too bright at night.']);

    const preview = await feedback.feedbackIntake.preview(scope, source, id, boardId);
    expect(preview.source).toEqual({
      suggestedTitle: 'Dark mode please',
      excerpt: 'Dark mode please\n\nThe timer screen is too bright at night.',
      endUserId: 'user-ada',
    });
    expect(preview.similar.map(post => post.title)).toEqual(['Dark mode for the timer']);
    expect(preview.linked).toEqual([]);
  });

  it('makes a post with the requester as a voter, and converting again finds the same post', async () => {
    const id = await conversation('user-ada', ['Export my sessions to CSV']);

    const first = await feedback.feedbackIntake.convert(scope, actor, {
      sourceType: source,
      sourceId: id,
      boardId,
      title: 'Export sessions to CSV',
    });
    expect(first).toMatchObject({ isNew: true, isVoteAdded: true, post: { number: 1, voteCount: 1 } });
    const votes = await feedback.feedbackVotes.list(scope, first.post.id, { limit: 10, offset: 0 });
    expect(votes.map(vote => [vote.endUserId, vote.source, vote.recordedByUserId])).toEqual([
      ['user-ada', FeedbackVoteSources.intake, actor],
    ]);

    const again = await feedback.feedbackIntake.convert(scope, actor, {
      sourceType: source,
      sourceId: id,
      boardId,
      title: 'Something else',
    });
    expect(again).toMatchObject({ isNew: false, isVoteAdded: false, post: { id: first.post.id, voteCount: 1 } });
    const posts = await feedback.feedbackPosts.list(scope, feedbackPostListInputSchema.parse({ boardId }));
    expect(posts).toHaveLength(1);

    const sources = await feedback.feedbackIntake.sourcesOf(scope, first.post.id);
    expect(sources.map(row => [row.sourceType, row.sourceId, row.excerpt, row.endUserId])).toEqual([
      [source, id, 'Export my sessions to CSV', 'user-ada'],
    ]);
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.feedbackPostConverted));
    expect(audit).toHaveLength(1);
  });

  it('adds a request to an existing post, counting a requester who voted already once', async () => {
    const existing = await feedback.feedbackPosts.create(scope, actor, { boardId, title: 'Dark mode' });
    await feedback.feedbackVotes.vote(scope, existing.id, 'user-ada', { source: FeedbackVoteSources.web });
    const id = await conversation('user-ada', ['Dark mode please']);

    const added = await feedback.feedbackIntake.convert(scope, actor, {
      sourceType: source,
      sourceId: id,
      intoPostId: existing.id,
    });
    expect(added).toMatchObject({ isNew: true, isVoteAdded: false, post: { id: existing.id, voteCount: 1 } });
    const linked = await feedback.feedbackIntake.postsOf(scope, source, id);
    expect(linked.map(link => link.post.id)).toEqual([existing.id]);
  });

  it("records a guest's request without a vote, since their address was never confirmed", async () => {
    const id = await conversation(null, ['Calendar sync please']);
    const result = await feedback.feedbackIntake.convert(scope, actor, {
      sourceType: source,
      sourceId: id,
      boardId,
      title: 'Calendar sync',
    });
    expect(result).toMatchObject({ isNew: true, isVoteAdded: false, post: { voteCount: 0 } });
    const [row] = await feedback.feedbackIntake.sourcesOf(scope, result.post.id);
    expect(row?.endUserId).toBeNull();
  });

  it('answers the live post when the linked one was merged, and refuses a merged target', async () => {
    const id = await conversation('user-ada', ['Dark mode']);
    const { post } = await feedback.feedbackIntake.convert(scope, actor, {
      sourceType: source,
      sourceId: id,
      boardId,
      title: 'Dark mode',
    });
    const keeper = await feedback.feedbackPosts.create(scope, actor, { boardId, title: 'Dark theme' });
    await feedback.feedbackMerges.merge(scope, actor, post.id, keeper.id);

    const again = await feedback.feedbackIntake.convert(scope, actor, {
      sourceType: source,
      sourceId: id,
      boardId,
      title: 'x',
    });
    expect(again.post.id).toBe(keeper.id);
    const other = await conversation('user-bob', ['Dark please']);
    expect(
      await outcome(
        async () =>
          await feedback.feedbackIntake.convert(scope, actor, {
            sourceType: source,
            sourceId: other,
            intoPostId: post.id,
          }),
      ),
    ).toBe('FeedbackPostMergedError');
  });

  it('erasing the contact forgets the sources quoting them and keeps the post', async () => {
    const id = await conversation('user-ada', ['Dark mode please']);
    const { post } = await feedback.feedbackIntake.convert(scope, actor, {
      sourceType: source,
      sourceId: id,
      boardId,
      title: 'Dark mode',
    });
    const [row] = await t.db.select().from(messengerConversations).where(eq(messengerConversations.id, id));
    await eraseContact({ db: t.db }, { id: row?.contactId ?? '', workspaceId: scope.workspaceId });
    expect(await feedback.feedbackIntake.sourcesOf(scope, post.id)).toEqual([]);
    const kept = await feedback.feedbackPosts.requirePost(scope, post.id);
    expect(kept.title).toBe('Dark mode');
  });

  it("doesn't read another project's conversation", async () => {
    const id = await conversation('user-ada', ['Dark mode']);
    const elsewhere = { workspaceId: scope.workspaceId, projectId: randomUUID() };
    const project = await createProjectDomain(t.db).projects.create(scope.workspaceId, { name: 'B', handle: 'b' });
    const other = { workspaceId: scope.workspaceId, projectId: project.id };
    const otherBoard = await feedback.feedbackBoards.createBoard(other, actor, { slug: 'ideas', name: 'Ideas' });
    expect(await outcome(async () => await feedback.feedbackIntake.preview(other, source, id, otherBoard.id))).toBe(
      'FeedbackSourceNotFoundError',
    );
    expect(
      await outcome(
        async () =>
          await feedback.feedbackIntake.convert(other, actor, {
            sourceType: source,
            sourceId: id,
            boardId: otherBoard.id,
            title: 'x',
          }),
      ),
    ).toBe('FeedbackSourceNotFoundError');
    expect(await outcome(async () => await feedback.feedbackIntake.preview(elsewhere, source, id, boardId))).toBe(
      'FeedbackBoardNotFoundError',
    );
    expect(await outcome(async () => await feedback.feedbackIntake.preview(scope, source, 'not-a-uuid', boardId))).toBe(
      'FeedbackSourceNotFoundError',
    );
  });
});
