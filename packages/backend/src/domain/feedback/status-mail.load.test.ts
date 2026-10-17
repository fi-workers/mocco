// LOAD TEST (#180): a status change followed by 10,000 email voters, sent through a fake
// transport. It proves the fan-out stays inside the job's limits (changesPerRun settled per run,
// one INSERT … SELECT for every follower, at most mailsPerRun claimed and sent per run), that every
// recipient is mailed exactly once even with transient failures in the mix, and that running the
// steps again, or re-queueing the change, mails no one twice. The followers are built with one
// INSERT … SELECT over generate_series so the test stays a few seconds on pglite.
import { randomUUID } from 'node:crypto';

import {
  FeedbackPostStatuses,
  FeedbackStatusMailStates,
  FeedbackVoteSources,
  FeedbackVoteStates,
} from '@mocco/common/feedback';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
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

const RECIPIENTS = 10_000;
/** Every this-many-th address fails once with a transient error before it goes through. */
const FLAKY_EVERY = 100;
const QUIET_POSTS = 30;

/** A transport that sends nothing: it counts attempts and deliveries per address. */
class FakeTransport implements EmailSender {
  private readonly failedOnce = new Set<string>();

  attempts = 0;

  readonly delivered = new Map<string, number>();

  async send(message: EmailMessage): Promise<EmailResult> {
    this.attempts++;
    const index = Number(/voter(\d+)@/u.exec(message.to)?.[1] ?? '1');
    if (index % FLAKY_EVERY === 0 && !this.failedOnce.has(message.to)) {
      this.failedOnce.add(message.to);
      return await Promise.resolve({ kind: EmailResultKinds.transient, reason: 'timeout' });
    }
    this.delivered.set(message.to, (this.delivered.get(message.to) ?? 0) + 1);
    return await Promise.resolve({ kind: EmailResultKinds.sent, messageId: null });
  }
}

describe('status mail fan-out to 10,000 followers (load test, pglite)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let scope: FeedbackScope;
  let actor: string;
  let transport: FakeTransport;
  let clock: Date;
  let mail: StatusMailService;
  let popularId: string;

  beforeAll(async () => {
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
    transport = new FakeTransport();
    clock = new Date();
    mail = new StatusMailService({
      db: t.db,
      email: transport,
      unsubscribeUrlOf: (_scope, postId, endUserId) => `https://mocco.test/unsubscribe/${postId}/${endUserId}`,
      publicUrlOf: async (_scope, path) => await Promise.resolve(`https://acme.help.test${path}`),
      now: () => clock,
    });

    const popular = await feedback.feedbackPosts.create(scope, actor, { boardId: board.id, title: 'Popular' });
    popularId = popular.id;
    // Confirmed email voters who follow the post, built in the database in one statement each.
    await t.db.execute(sql`
      INSERT INTO ${feedbackVotes} (workspace_id, post_id, end_user_id, state, source, counted_at)
      SELECT ${scope.workspaceId}::uuid, ${popularId}::uuid, 'email:voter' || g || '@example.com',
        ${FeedbackVoteStates.counted}, ${FeedbackVoteSources.web}, now()
      FROM generate_series(1, ${RECIPIENTS}) AS g`);
    await t.db.execute(sql`
      INSERT INTO ${feedbackSubscriptions} (workspace_id, post_id, end_user_id)
      SELECT ${scope.workspaceId}::uuid, ${popularId}::uuid, 'email:voter' || g || '@example.com'
      FROM generate_series(1, ${RECIPIENTS}) AS g`);
    // Changes nobody follows, made before it: they fill the first fan-out run.
    await Array.from({ length: QUIET_POSTS }).reduce<Promise<void>>(async (previous, _, index) => {
      await previous;
      const quiet = await feedback.feedbackPosts.create(scope, actor, {
        boardId: board.id,
        title: `Quiet ${String(index)}`,
      });
      await feedback.feedbackPosts.setStatus(scope, actor, quiet.id, FeedbackPostStatuses.planned);
    }, Promise.resolve());
    await feedback.feedbackPosts.setStatus(scope, actor, popularId, FeedbackPostStatuses.planned);
    const [newest] = await t.db
      .select({ at: feedbackStatusChanges.createdAt })
      .from(feedbackStatusChanges)
      .orderBy(desc(feedbackStatusChanges.createdAt))
      .limit(1);
    clock = new Date((newest?.at ?? new Date()).getTime() + StatusMailPolicy.delayMs + 60_000);
  }, 60_000);
  afterAll(async () => {
    await t.close();
  });

  const settledChanges = async () => {
    const rows = await t.db
      .select({ id: feedbackStatusChanges.id })
      .from(feedbackStatusChanges)
      .where(isNotNull(feedbackStatusChanges.notifiedAt));
    return rows.length;
  };

  it('settles at most changesPerRun changes a run, and queues all 10,000 followers in one', async () => {
    const { length: changes } = await t.db.select({ id: feedbackStatusChanges.id }).from(feedbackStatusChanges);
    // The popular post's creation, each quiet post's creation and move, then the popular move.
    expect(changes).toBe(2 + 2 * QUIET_POSTS);
    expect(changes).toBeGreaterThan(StatusMailPolicy.changesPerRun);

    expect(await mail.fanOutDue()).toBe(0);
    expect(await settledChanges()).toBe(StatusMailPolicy.changesPerRun);
    expect(await mail.fanOutDue()).toBe(RECIPIENTS);
    expect(await settledChanges()).toBe(changes);
    expect(await mail.fanOutDue()).toBe(0);
  });

  it('sends in runs of at most mailsPerRun, each recipient exactly once, retrying the transient failures', async () => {
    const perRun: number[] = [];
    let isDone = false;
    while (!isDone) {
      const before = transport.attempts;
      // eslint-disable-next-line no-await-in-loop -- runs are sequential, like the job's
      await mail.sendQueued();
      const attempted = transport.attempts - before;
      perRun.push(attempted);
      isDone = attempted === 0;
      expect(perRun.length).toBeLessThan(100);
    }
    const flaky = RECIPIENTS / FLAKY_EVERY;
    const runs = perRun.slice(0, -1);
    expect(runs.every(attempted => attempted <= StatusMailPolicy.mailsPerRun)).toBe(true);
    expect(runs).toHaveLength(Math.ceil((RECIPIENTS + flaky) / StatusMailPolicy.mailsPerRun));
    expect(transport.attempts).toBe(RECIPIENTS + flaky);
    expect(transport.delivered.size).toBe(RECIPIENTS);
    // Every address once: the only delivery count there is, is one.
    expect(new Set(transport.delivered.values())).toEqual(new Set([1]));

    const states = await t.db
      .select({ state: feedbackStatusMails.state, count: sql<number>`count(*)::int` })
      .from(feedbackStatusMails)
      .groupBy(feedbackStatusMails.state);
    expect(states).toEqual([{ state: FeedbackStatusMailStates.sent, count: RECIPIENTS }]);
    // About 5 s alone on pglite; room for a loaded machine running every suite at once.
  }, 120_000);

  it('mails no one twice when the steps run again or the change is queued again', async () => {
    const { attempts } = transport;
    expect(await mail.fanOutDue()).toBe(0);
    expect(await mail.sendQueued()).toBe(0);
    // A retry of the whole fan-out: the change unsettled, as if the run died before committing.
    await t.db
      .update(feedbackStatusChanges)
      .set({ notifiedAt: null })
      .where(eq(feedbackStatusChanges.postId, popularId));
    expect(await mail.fanOutDue()).toBe(0);
    expect(await mail.sendQueued()).toBe(0);
    expect(transport.attempts).toBe(attempts);
    const queued = await t.db.select({ id: feedbackStatusMails.id }).from(feedbackStatusMails);
    expect(queued).toHaveLength(RECIPIENTS);
  });
});
