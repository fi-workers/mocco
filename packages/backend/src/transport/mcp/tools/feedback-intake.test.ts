// The duplicate, intake and source tools (`tools/feedback-intake.ts`) and the follower and unvote
// tools (`tools/feedback-followers.ts`) over a real database, through the real HTTP handler. The
// requests are real messenger conversations, read by messenger's own feedback source.
//
// The reads stay inside the caller's project. The changes have every lock a changing tool has,
// write nothing until the person says yes, and refuse an answer once what they were asked about
// changed.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import {
  FeedbackDuplicateMethods,
  FeedbackDuplicateStates,
  FeedbackSourceTypes,
  FeedbackVoteSources,
  FeedbackVoteStates,
} from '@mocco/common/feedback';
import { AuthorKinds, ConversationStatuses, MessageVisibilities } from '@mocco/common/messenger';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { messengerFeedbackSource } from '@backend/domain/messenger/feedback-source';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  feedbackDuplicateCandidates,
  feedbackPostSources,
  feedbackPosts,
  messengerContacts,
  messengerConversations,
  messengerMessages,
} from '@backend/infra/db/schema';
import {
  WRITE,
  createFeedbackHarness,
  isAsking,
  messageOf,
  textOf,
} from '@backend/transport/mcp/testing/feedback-harness';

import type { FeedbackHarness, RpcAnswer, Scope } from '@backend/transport/mcp/testing/feedback-harness';

const DUPLICATES = 'mocco_feedback_duplicates_list';
const DISMISS = 'mocco_feedback_duplicate_dismiss';
const PREVIEW = 'mocco_feedback_intake_preview';
const CONVERT = 'mocco_feedback_intake_convert';
const SOURCE_POSTS = 'mocco_feedback_source_posts_list';
const POST_SOURCES = 'mocco_feedback_post_sources_list';
const SUBSCRIBERS = 'mocco_feedback_subscribers_list';
const UNVOTE = 'mocco_feedback_post_unvote';

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

function expectRefused(refusal: RpcAnswer) {
  expect(refusal.result?.isError, textOf(refusal)).toBe(true);
  expect(isAsking(refusal)).toBe(false);
}

describe('mocco_feedback duplicates, intake, followers (pglite, over HTTP)', () => {
  let h: FeedbackHarness;
  let ideas: string;
  let darkMode: string;
  let darkTheme: string;
  let pair: string;
  /** A signed-in user's conversation asking for dark mode, and a guest's. */
  let fromAnn: string;
  let fromGuest: string;
  let foreignPost: string;
  let foreignConversation: string;

  const postRow = async (id: string) =>
    expectOne(await h.t.db.select().from(feedbackPosts).where(eq(feedbackPosts.id, id)));
  const pairRow = async (id: string) =>
    expectOne(await h.t.db.select().from(feedbackDuplicateCandidates).where(eq(feedbackDuplicateCandidates.id, id)));

  async function asks(tool: string, args: Row) {
    const { asked, requestState } = await h.ask(tool, args);
    expect(isAsking(asked), textOf(asked)).toBe(true);
    return { message: messageOf(asked), requestState };
  }

  /** A conversation the contact started with `lines`, plus an internal note; a guest when `externalUserId` is null. */
  async function conversation(scope: Scope, externalUserId: string | null, lines: string[]) {
    const contact = expectOne(
      await h.t.db
        .insert(messengerContacts)
        .values({
          ...scope,
          externalUserId,
          ...(externalUserId === null && { email: 'guest@example.com', guestTokenHash: randomUUID() }),
          lastSeenAt: new Date(),
        })
        .returning(),
    );
    const conversationId = expectOne(
      await h.t.db
        .insert(messengerConversations)
        .values({
          ...scope,
          contactId: contact.id,
          status: ConversationStatuses.open,
          lastMessageAt: new Date(),
          preview: lines[0] ?? '',
        })
        .returning(),
    ).id;
    await h.t.db.insert(messengerMessages).values([
      ...lines.map((body, index) => ({
        workspaceId: scope.workspaceId,
        conversationId,
        seq: index + 1,
        authorKind: AuthorKinds.contact,
        visibility: MessageVisibilities.public,
        body,
      })),
      {
        workspaceId: scope.workspaceId,
        conversationId,
        seq: 100,
        authorKind: AuthorKinds.operator,
        authorUserId: h.ada,
        visibility: MessageVisibilities.internal,
        body: 'Internal: big customer',
      },
    ]);
    return conversationId;
  }

  const changes = (): [string, Row][] => [
    [DISMISS, { duplicateId: pair }],
    [CONVERT, { sourceId: fromAnn, boardId: ideas, title: 'X' }],
    [UNVOTE, { postId: darkMode, endUserId: 'ann' }],
  ];

  beforeEach(async () => {
    h = await createFeedbackHarness({
      sources: db => ({ [FeedbackSourceTypes.messengerConversation]: messengerFeedbackSource(db) }),
    });
    const { feedback, mine, theirs, ada, eve } = h;
    ({ id: ideas } = await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'ideas', name: 'Ideas' }));
    ({ id: darkMode } = await feedback.feedbackPosts.create(mine, ada, { boardId: ideas, title: 'Dark mode please' }));
    ({ id: darkTheme } = await feedback.feedbackPosts.create(mine, ada, { boardId: ideas, title: 'Dark theme' }));
    pair = expectOne(
      await h.t.db
        .insert(feedbackDuplicateCandidates)
        .values({
          ...mine,
          boardId: ideas,
          postId: darkTheme,
          candidatePostId: darkMode,
          score: 0.5,
          method: FeedbackDuplicateMethods.fulltext,
        })
        .returning(),
    ).id;
    const web = { source: FeedbackVoteSources.web };
    await feedback.feedbackVotes.vote(mine, darkMode, 'ann', web);
    await feedback.feedbackVotes.vote(mine, darkMode, 'bob', { ...web, state: FeedbackVoteStates.pending });
    fromAnn = await conversation(mine, 'cy', ['Dark mode please', 'The timer is too bright at night.']);
    fromGuest = await conversation(mine, null, ['Export to CSV']);

    const theirBoard = await feedback.feedbackBoards.createBoard(theirs, eve, { slug: 'ideas', name: 'Theirs' });
    ({ id: foreignPost } = await feedback.feedbackPosts.create(theirs, eve, {
      boardId: theirBoard.id,
      title: 'Secret',
    }));
    foreignConversation = await conversation(theirs, 'their-user', ['Their secret request']);
  });
  afterEach(async () => {
    await h.close();
  });

  describe('duplicates', () => {
    it('lists the open pairs with both posts and the open count', async () => {
      const listed = bodyOf(await h.call(DUPLICATES, { boardId: ideas }));
      expect(listed.openCount).toBe(1);
      expect(listed.pairs).toEqual([
        expect.objectContaining({
          id: pair,
          method: FeedbackDuplicateMethods.fulltext,
          post: expect.objectContaining({ id: darkTheme, number: 2 }),
          original: expect.objectContaining({ id: darkMode, number: 1, voteCount: 1 }),
        }),
      ]);
    });

    it('dismisses once confirmed, audited, and refuses a second dismissal before asking', async () => {
      const { message, requestState } = await asks(DISMISS, { duplicateId: pair });
      expect(message).toContain('#2 "Dark theme" and #1 "Dark mode please"');
      expect(await pairRow(pair)).toMatchObject({ state: FeedbackDuplicateStates.open });
      expect(bodyOf(await h.answer(DISMISS, { duplicateId: pair }, requestState))).toMatchObject({ dismissed: true });
      expect(await pairRow(pair)).toMatchObject({ state: FeedbackDuplicateStates.dismissed });
      const audit = await h.t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditActions.feedbackDuplicateDismissed));
      expect(audit.map(row => row.actorUserId)).toEqual([h.ada]);
      expectRefused(await h.call(DISMISS, { duplicateId: pair }, WRITE));
    });

    it('refuses an answer once a post of the pair was merged', async () => {
      const { requestState } = await asks(DISMISS, { duplicateId: pair });
      await h.feedback.feedbackMerges.merge(h.mine, h.ada, darkTheme, darkMode);
      expectRefused(await h.answer(DISMISS, { duplicateId: pair }, requestState));
      expect(await pairRow(pair)).toMatchObject({ state: FeedbackDuplicateStates.open });
    });
  });

  describe('intake', () => {
    it("previews a conversation from the contact's words, never internal notes, with similar posts", async () => {
      const preview = bodyOf(await h.call(PREVIEW, { boardId: ideas, sourceId: fromAnn }));
      expect(preview.source).toMatchObject({ suggestedTitle: 'Dark mode please', requesterEndUserId: 'cy' });
      expect(JSON.stringify(preview)).not.toContain('Internal');
      expect((preview.similar as Row[]).map(post => post.id)).toContain(darkMode);
      expect(preview.alreadyBecame).toEqual([]);
    });

    it('makes a new post once confirmed; the requester votes, and asking again answers that post', async () => {
      const args = { sourceId: fromAnn, boardId: ideas, title: 'Night mode', body: 'From support' };
      const { message } = await asks(CONVERT, args);
      expect(message).toContain('new feedback post "Night mode"');
      expect(message).toContain('("cy") votes for it');
      expect(message).toContain('The timer is too bright at night.');
      expect(message).not.toContain('Internal');
      const converted = bodyOf(await h.confirmed(CONVERT, args));
      expect(converted).toMatchObject({ converted: true, isNewPost: true, isVoteAdded: true, voteCount: 1 });
      const postId = String(converted.postId);
      expect(await postRow(postId)).toMatchObject({ title: 'Night mode', authorUserId: h.ada });

      const again = await h.call(CONVERT, args, WRITE);
      expect(isAsking(again)).toBe(false);
      expect(bodyOf(again)).toMatchObject({ changed: false, postId });

      const became = bodyOf(await h.call(SOURCE_POSTS, { sourceId: fromAnn }));
      expect((became.posts as Row[]).map(post => post.id)).toEqual([postId]);
      const sources = bodyOf(await h.call(POST_SOURCES, { postId, responseFormat: 'detailed' }));
      expect(sources.sources).toEqual([
        expect.objectContaining({ id: fromAnn, requesterEndUserId: 'cy', convertedByUserId: h.ada }),
      ]);
    });

    it("adds a guest's request to an existing post without a vote, and refuses a stale answer", async () => {
      const args = { sourceId: fromGuest, intoPostId: darkMode };
      const { message, requestState } = await asks(CONVERT, args);
      expect(message).toContain('Add this request to feedback post #1 "Dark mode please"');
      expect(message).toContain('no vote is recorded');
      // Converted elsewhere in the meantime: the answer is for a different change.
      await h.feedback.feedbackIntake.convert(h.mine, h.ada, {
        sourceType: FeedbackSourceTypes.messengerConversation,
        sourceId: fromGuest,
        intoPostId: darkTheme,
      });
      expect(textOf(await h.answer(CONVERT, args, requestState))).toContain('different change');
      const added = bodyOf(await h.confirmed(CONVERT, args));
      expect(added).toMatchObject({ converted: true, isNewPost: false, isVoteAdded: false, voteCount: 1 });
      const links = await h.t.db.select().from(feedbackPostSources).where(eq(feedbackPostSources.sourceId, fromGuest));
      expect(new Set(links.map(row => row.postId))).toEqual(new Set([darkMode, darkTheme]));
    });

    it("refuses an incomplete target, a merged post, and another workspace's request before asking", async () => {
      expectRefused(await h.call(CONVERT, { sourceId: fromAnn, boardId: ideas }, WRITE));
      expectRefused(
        await h.call(CONVERT, { sourceId: fromAnn, boardId: ideas, title: 'X', intoPostId: darkMode }, WRITE),
      );
      await h.feedback.feedbackMerges.merge(h.mine, h.ada, darkTheme, darkMode);
      expectRefused(await h.call(CONVERT, { sourceId: fromAnn, intoPostId: darkTheme }, WRITE));
      const theirs = await h.call(CONVERT, { sourceId: foreignConversation, boardId: ideas, title: 'X' }, WRITE);
      expectRefused(theirs);
      expect(textOf(theirs)).not.toContain('secret');
      expectRefused(await h.call(PREVIEW, { boardId: ideas, sourceId: foreignConversation }));
      expectRefused(await h.call(POST_SOURCES, { postId: foreignPost }));
    });
  });

  describe('followers and unvote', () => {
    it("lists a post's followers, paged", async () => {
      const first = bodyOf(await h.call(SUBSCRIBERS, { postId: darkMode, limit: 1 }));
      expect(first.subscribers).toEqual([{ endUserId: 'ann', since: expect.any(String) }]);
      expect(first.nextOffset).toBe(1);
      const next = bodyOf(await h.call(SUBSCRIBERS, { postId: darkMode, offset: 1 }));
      expect((next.subscribers as Row[]).map(row => row.endUserId)).toEqual(['bob']);
      expectRefused(await h.call(SUBSCRIBERS, { postId: foreignPost }));
    });

    it('removes a counted vote once confirmed, and answers without asking when there is none', async () => {
      const { message } = await asks(UNVOTE, { postId: darkMode, endUserId: 'ann' });
      expect(message).toContain('Votes now: 1, then 0.');
      expect(bodyOf(await h.confirmed(UNVOTE, { postId: darkMode, endUserId: 'ann' }))).toMatchObject({
        changed: true,
        voteCount: 0,
      });
      const none = await h.call(UNVOTE, { postId: darkMode, endUserId: 'ann' }, WRITE);
      expect(isAsking(none)).toBe(false);
      expect(bodyOf(none)).toMatchObject({ changed: false });
    });

    it('refuses an answer once a pending vote was confirmed meanwhile', async () => {
      const { message, requestState } = await asks(UNVOTE, { postId: darkMode, endUserId: 'bob' });
      expect(message).toContain('pending');
      await h.feedback.feedbackVotes.vote(h.mine, darkMode, 'bob', { source: FeedbackVoteSources.web });
      expect(textOf(await h.answer(UNVOTE, { postId: darkMode, endUserId: 'bob' }, requestState))).toContain(
        'different change',
      );
      expect(await postRow(darkMode)).toMatchObject({ voteCount: 2 });
    });
  });

  describe('locks', () => {
    it('challenges a token without feedback:write, and refuses without the opt-in', async () => {
      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const challenged = await h.call(tool, args);
        expect(challenged.status, tool).toBe(403);
        expect(challenged.wwwAuthenticate).toContain('feedback:write');
      }, Promise.resolve());
      await h.settings.setAgentsMayDecide(h.mine.workspaceId, false, h.ada);
      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const refusal = await h.call(tool, args, WRITE);
        expectRefused(refusal);
        expect(textOf(refusal), tool).toContain('Settings → Agents');
      }, Promise.resolve());
    });

    it('marks the reads read-only and the unvote destructive', async () => {
      const tools = await h.listTools();
      const hintsOf = (name: string) => tools.find(each => each.name === name)?.annotations;
      const names = [DUPLICATES, PREVIEW, SOURCE_POSTS, POST_SOURCES, SUBSCRIBERS];
      expect(names.map(name => hintsOf(name))).toEqual(
        names.map(() => expect.objectContaining({ readOnlyHint: true })),
      );
      expect(hintsOf(DISMISS)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(hintsOf(CONVERT)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(hintsOf(UNVOTE)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    });
  });
});
