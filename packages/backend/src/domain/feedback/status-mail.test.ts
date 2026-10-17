import { randomUUID } from 'node:crypto';

import { FeedbackPostStatuses, FeedbackStatusMailStates, FeedbackVoteStates } from '@mocco/common/feedback';
import { desc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { FeedbackMailOptOutRepo } from '@backend/domain/feedback/repos/mail-opt-out.repo';
import { FeedbackStatusMailRepo } from '@backend/domain/feedback/repos/status-mail.repo';
import { StatusMailPolicy, StatusMailService } from '@backend/domain/feedback/StatusMailService';
import { EmailResultKinds } from '@backend/domain/notification/senders/email';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import {
  feedbackStatusChanges,
  feedbackStatusMails,
  feedbackSubscriptions,
  feedbackVotes,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { EmailMessage, EmailResult, EmailSender } from '@backend/domain/notification/senders/email';
import type { FeedbackPostStatus } from '@mocco/common/feedback';

/** A sender that records each mail and answers with the next queued result (sent by default). */
class FakeEmail implements EmailSender {
  readonly sent: EmailMessage[] = [];

  readonly results: EmailResult[] = [];

  async send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return await Promise.resolve(this.results.shift() ?? { kind: EmailResultKinds.sent, messageId: null });
  }
}

const AFTER_WINDOW = StatusMailPolicy.delayMs + 60_000;

describe('status mail (pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let actor: string;
  let boardId: string;
  let email: FakeEmail;
  let clock: Date;
  let mail: StatusMailService;

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
    boardId = board.id;
    email = new FakeEmail();
    clock = new Date();
    mail = new StatusMailService({
      db: t.db,
      email,
      unsubscribeUrlOf: (_scope, postId, endUserId) => `https://mocco.test/unsubscribe/${postId}/${endUserId}`,
      publicUrlOf: async (_scope, path) => await Promise.resolve(`https://acme.help.test${path}`),
      now: () => clock,
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const post = async (title = 'Dark mode') => await feedback.feedbackPosts.create(scope, actor, { boardId, title });
  const vote = async (postId: string, endUserId: string, state: 'counted' | 'pending' = 'counted') =>
    await feedback.feedbackVotes.vote(scope, postId, endUserId, {
      source: 'web',
      ...(state === 'pending' && { state: FeedbackVoteStates.pending }),
    });
  const move = async (postId: string, status: FeedbackPostStatus) =>
    await feedback.feedbackPosts.setStatus(scope, actor, postId, status);
  /** `ms` after the newest status change, as the database stamped it (its clock, not the test's). */
  const later = async (ms: number) => {
    const [newest] = await t.db
      .select({ at: feedbackStatusChanges.createdAt })
      .from(feedbackStatusChanges)
      .orderBy(desc(feedbackStatusChanges.createdAt))
      .limit(1);
    return new Date((newest?.at ?? new Date()).getTime() + ms);
  };
  const runAfterWindow = async () => {
    clock = await later(AFTER_WINDOW);
    const queued = await mail.fanOutDue();
    const sent = await mail.sendQueued();
    return { queued, sent };
  };

  it('mails confirmed email voters who still follow, once, after the undo window', async () => {
    const dark = await post();
    await vote(dark.id, 'email:ada@example.com');
    await vote(dark.id, 'email:pending@example.com', 'pending');
    await vote(dark.id, 'signed-in-user');
    await vote(dark.id, 'email:left@example.com');
    await feedback.feedbackSubscriptions.unsubscribe(scope, dark.id, 'email:left@example.com');
    await move(dark.id, FeedbackPostStatuses.planned);

    // Within the window nothing goes out.
    clock = await later(StatusMailPolicy.delayMs - 30_000);
    expect(await mail.fanOutDue()).toBe(0);
    expect(await runAfterWindow()).toEqual({ queued: 1, sent: 1 });
    expect(email.sent).toHaveLength(1);
    const [message] = email.sent;
    expect(message).toMatchObject({
      to: 'ada@example.com',
      subject: '"Dark mode" is planned',
      headers: {
        'List-Unsubscribe': `<https://mocco.test/unsubscribe/${dark.id}/email:ada@example.com>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    expect(message?.text).toContain(`See the post: https://acme.help.test/feedback/ideas/${String(dark.number)}`);
    expect(message?.text).toContain("You get this because you voted for it on Acme's feedback board.");
    expect(message?.text).toContain(
      `Stop all mail about Acme's feedback: https://mocco.test/unsubscribe/${dark.id}/email:ada@example.com/all`,
    );

    // Running again sends nothing new.
    expect(await runAfterWindow()).toEqual({ queued: 0, sent: 0 });
    expect(email.sent).toHaveLength(1);
  });

  it('mails only the latest of quick changes, and nothing for under review, merges or private boards', async () => {
    const quick = await post('Quick');
    await vote(quick.id, 'email:ada@example.com');
    await move(quick.id, FeedbackPostStatuses.planned);
    await move(quick.id, FeedbackPostStatuses.inProgress);

    const back = await post('Back');
    await vote(back.id, 'email:ada@example.com');
    await move(back.id, FeedbackPostStatuses.planned);
    await move(back.id, FeedbackPostStatuses.underReview);

    const duplicate = await post('Duplicate');
    await vote(duplicate.id, 'email:bob@example.com');
    await feedback.feedbackMerges.merge(scope, actor, duplicate.id, back.id);

    expect(await runAfterWindow()).toEqual({ queued: 1, sent: 1 });
    expect(email.sent.map(message => message.subject)).toEqual(['Work has started on "Quick"']);

    await feedback.feedbackBoards.updateBoard(scope, boardId, { slug: 'ideas', name: 'Ideas', isPublic: false });
    await move(quick.id, FeedbackPostStatuses.shipped);
    expect(await runAfterWindow()).toEqual({ queued: 0, sent: 0 });
  });

  it('links the changelog entry a shipped post went out in', async () => {
    const shipped = await post('Widgets');
    await vote(shipped.id, 'email:ada@example.com');
    const entry = await feedback.feedbackChangelog.create(scope, actor, {
      boardId,
      title: 'Widgets are here',
      postIds: [shipped.id],
    });
    await feedback.feedbackChangelog.publish(scope, actor, entry.id);
    await move(shipped.id, FeedbackPostStatuses.shipped);
    await runAfterWindow();
    expect(email.sent[0]?.subject).toBe('"Widgets" has shipped');
    expect(email.sent[0]?.text).toContain(
      'Read what shipped: https://acme.help.test/feedback/ideas/changelog/widgets-are-here',
    );
  });

  it('skips a follower who stopped following before the send, and escapes the title in HTML', async () => {
    const tricky = await post('<b>Bold</b> & "quoted"');
    await vote(tricky.id, 'email:ada@example.com');
    await vote(tricky.id, 'email:bob@example.com');
    await move(tricky.id, FeedbackPostStatuses.closed);
    clock = await later(AFTER_WINDOW);
    expect(await mail.fanOutDue()).toBe(2);
    await feedback.feedbackSubscriptions.unsubscribe(scope, tricky.id, 'email:bob@example.com');
    expect(await mail.sendQueued()).toBe(1);
    expect(email.sent.map(message => message.to)).toEqual(['ada@example.com']);
    expect(email.sent[0]?.html).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;');
    expect(email.sent[0]?.html).not.toContain('<b>Bold</b>');
    const states = await t.db.select().from(feedbackStatusMails);
    expect(Object.fromEntries(states.map(row => [row.endUserId, row.state]))).toEqual({
      'email:ada@example.com': FeedbackStatusMailStates.sent,
      'email:bob@example.com': FeedbackStatusMailStates.skipped,
    });
  });

  it("skips an address that stopped all of the project's mail, at queueing and at sending, and only in that project", async () => {
    const optOuts = new FeedbackMailOptOutRepo(t.db);
    const first = await post('First');
    const second = await post('Second');
    await vote(first.id, 'email:ada@example.com');
    await vote(first.id, 'email:bob@example.com');
    await vote(second.id, 'email:ada@example.com');
    await vote(second.id, 'email:carol@example.com');
    // Carol stops this one post only; Ada stops all of Acme's mail.
    await feedback.feedbackSubscriptions.unsubscribe(scope, second.id, 'email:carol@example.com');
    await optOuts.optOut(scope, 'email:ada@example.com');
    await optOuts.optOut(scope, 'email:ada@example.com');

    // Another project of the workspace, where Ada still follows.
    const beta = await createProjectDomain(t.db).projects.create(scope.workspaceId, { name: 'Beta', handle: 'beta' });
    const betaScope = { workspaceId: scope.workspaceId, projectId: beta.id };
    const betaBoard = await feedback.feedbackBoards.createBoard(betaScope, actor, { slug: 'ideas', name: 'Ideas' });
    const elsewhere = await feedback.feedbackPosts.create(betaScope, actor, {
      boardId: betaBoard.id,
      title: 'Elsewhere',
    });
    await feedback.feedbackVotes.vote(betaScope, elsewhere.id, 'email:ada@example.com', { source: 'web' });

    await move(first.id, FeedbackPostStatuses.planned);
    await move(second.id, FeedbackPostStatuses.planned);
    await feedback.feedbackPosts.setStatus(betaScope, actor, elsewhere.id, FeedbackPostStatuses.planned);
    expect(await runAfterWindow()).toEqual({ queued: 2, sent: 2 });
    expect(
      email.sent.map(message => [message.to, message.subject]).toSorted(([a = ''], [b = '']) => a.localeCompare(b)),
    ).toEqual([
      ['ada@example.com', '"Elsewhere" is planned'],
      ['bob@example.com', '"First" is planned'],
    ]);

    // Opting out after the mail was queued still stops it.
    await move(first.id, FeedbackPostStatuses.inProgress);
    clock = await later(AFTER_WINDOW);
    expect(await mail.fanOutDue()).toBe(1);
    await optOuts.optOut(scope, 'email:bob@example.com');
    expect(await mail.sendQueued()).toBe(0);
    const [skipped] = await t.db
      .select()
      .from(feedbackStatusMails)
      .where(eq(feedbackStatusMails.endUserId, 'email:bob@example.com'))
      .orderBy(desc(feedbackStatusMails.createdAt));
    expect(skipped?.state).toBe(FeedbackStatusMailStates.skipped);

    // Turning it back on mails the next change, and the per-post choices stand as they were.
    await optOuts.optIn(scope, 'email:ada@example.com');
    await move(second.id, FeedbackPostStatuses.shipped);
    const before = email.sent.length;
    expect(await runAfterWindow()).toEqual({ queued: 1, sent: 1 });
    expect(email.sent.slice(before).map(message => message.to)).toEqual(['ada@example.com']);
  });

  it('retries a transient failure up to the limit, gives up on a permanent one, and never resends a stale claim', async () => {
    const flaky = await post('Flaky');
    await vote(flaky.id, 'email:ada@example.com');
    await vote(flaky.id, 'email:bounce@example.com');
    await move(flaky.id, FeedbackPostStatuses.planned);
    clock = await later(AFTER_WINDOW);
    await mail.fanOutDue();
    email.results.push(
      { kind: EmailResultKinds.transient, reason: 'timeout' },
      { kind: EmailResultKinds.permanent, reason: 'unknown mailbox' },
    );
    await mail.sendQueued();
    const after = async () => {
      const rows = await t.db.select().from(feedbackStatusMails);
      return Object.fromEntries(rows.map(row => [row.endUserId, [row.state, row.attempts]]));
    };
    expect(await after()).toEqual({
      'email:ada@example.com': [FeedbackStatusMailStates.queued, 1],
      'email:bounce@example.com': [FeedbackStatusMailStates.failed, 1],
    });
    // Transient every time: given up after maxAttempts.
    email.results.push(
      ...Array.from({ length: StatusMailPolicy.maxAttempts }, () => ({
        kind: EmailResultKinds.transient,
        reason: 'timeout',
      })),
    );
    await [1, 2, 3, 4].reduce(async previous => {
      await previous;
      await mail.sendQueued();
    }, Promise.resolve());
    expect(await after()).toMatchObject({
      'email:ada@example.com': [FeedbackStatusMailStates.failed, StatusMailPolicy.maxAttempts],
    });

    // A claim a dead run left behind is given up, not sent.
    const stale = await post('Stale');
    await vote(stale.id, 'email:carol@example.com');
    await move(stale.id, FeedbackPostStatuses.planned);
    await mail.fanOutDue();
    await t.db
      .update(feedbackStatusMails)
      .set({ state: FeedbackStatusMailStates.sending, claimedAt: new Date(clock.getTime() - 60 * 60 * 1000) })
      .where(eq(feedbackStatusMails.endUserId, 'email:carol@example.com'));
    const before = email.sent.length;
    await mail.sendQueued();
    expect(email.sent).toHaveLength(before);
    const settled = await after();
    expect(settled['email:carol@example.com']?.[0]).toBe(FeedbackStatusMailStates.failed);
  });

  it('queues a large following in one fan-out and sends it in runs of mailsPerRun', async () => {
    const popular = await post('Popular');
    const voters = Array.from({ length: 450 }, (_, index) => `email:voter${String(index)}@example.com`);
    await t.db.insert(feedbackVotes).values(
      voters.map(endUserId => ({
        workspaceId: scope.workspaceId,
        postId: popular.id,
        endUserId,
        state: FeedbackVoteStates.counted,
        source: 'web' as const,
        countedAt: new Date(),
      })),
    );
    await t.db
      .insert(feedbackSubscriptions)
      .values(voters.map(endUserId => ({ workspaceId: scope.workspaceId, postId: popular.id, endUserId })));
    await move(popular.id, FeedbackPostStatuses.shipped);
    clock = await later(AFTER_WINDOW);
    expect(await mail.fanOutDue()).toBe(450);
    expect(await mail.sendQueued()).toBe(StatusMailPolicy.mailsPerRun);
    expect(await mail.sendQueued()).toBe(StatusMailPolicy.mailsPerRun);
    expect(await mail.sendQueued()).toBe(450 - 2 * StatusMailPolicy.mailsPerRun);
    expect(new Set(email.sent.map(message => message.to)).size).toBe(450);
  });

  it("doesn't take a change for newer than itself when the database keeps microseconds", async () => {
    const precise = await post('Precise');
    await move(precise.id, FeedbackPostStatuses.planned);
    // Postgres keeps microseconds; a JS Date read back from it keeps milliseconds.
    await t.db.execute(
      sql`UPDATE ${feedbackStatusChanges} SET created_at = created_at + interval '123 microseconds' WHERE post_id = ${precise.id}`,
    );
    const repo = new FeedbackStatusMailRepo(t.db);
    const changes = await t.db.select().from(feedbackStatusChanges).where(eq(feedbackStatusChanges.postId, precise.id));
    const planned = changes.find(change => change.toStatus === FeedbackPostStatuses.planned);
    expect(planned).toBeDefined();
    expect(planned === undefined ? true : await repo.hasNewerChange(planned)).toBe(false);
  });

  it('settles changes with no mail when this deployment sends none', async () => {
    const quiet = await post('Quiet');
    await vote(quiet.id, 'email:ada@example.com');
    await move(quiet.id, FeedbackPostStatuses.planned);
    clock = await later(AFTER_WINDOW);
    const silent = new StatusMailService({
      db: t.db,
      email: undefined,
      unsubscribeUrlOf: () => '',
      publicUrlOf: async () => await Promise.resolve(null),
      now: () => clock,
    });
    expect(await silent.fanOutDue()).toBe(0);
    // Settled: a later run with a sender doesn't mail it either.
    expect(await runAfterWindow()).toEqual({ queued: 0, sent: 0 });
  });
});
