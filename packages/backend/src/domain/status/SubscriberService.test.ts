// Status page subscribers (#156) on pglite, through the real job runner: double opt-in (an
// unconfirmed address gets only the confirmation mail), the fan-out of incident updates and
// maintenance changes with component filters, at most one mail per subscriber and notice however
// often the fan-out or delivery runs, and the signed single-purpose links.
import { randomUUID } from 'node:crypto';

import { DeliveryStatuses } from '@mocco/common/notification';
import {
  ComponentStatuses,
  IncidentSeverities,
  IncidentStatuses,
  IncidentVisibilities,
  SubscriberLocales,
  SubscriberMailKinds,
} from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { RetryAt } from '@backend/domain/jobs/retry-at';
import { EmailResultKinds } from '@backend/domain/notification/senders/email';
import { createRecordingEmailSender } from '@backend/domain/notification/testing/recording-email';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { SubscriberTokenError } from '@backend/domain/status/errors';
import { CONFIRM_TOKEN_TTL_MS, SubscriberTokens } from '@backend/domain/status/subscriber-token';
import { noticeKeyOf } from '@backend/domain/status/SubscriberNotices';
import { SubscribeOutcomes, SubscriberPolicy } from '@backend/domain/status/SubscriberService';
import { expectOne } from '@backend/infra/db/rows';
import {
  statusIncidents,
  statusSubscriberDeliveries,
  statusSubscribers,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';

import type { JobRunner } from '@backend/domain/jobs/JobRunner';
import type { EmailMessage } from '@backend/domain/notification/senders/email';
import type { RecordingEmailSender } from '@backend/domain/notification/testing/recording-email';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { SubscriberNotice } from '@backend/domain/status/jobs';
import type { StatusScope } from '@backend/domain/status/scope';
import type { SubscriberService } from '@backend/domain/status/SubscriberService';

const T0 = new Date('2026-10-06T09:00:00.000Z');
const APP_ORIGIN = 'https://mocco.test';
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** The `token` of the link to `action` in a mail. */
function tokenIn(mail: EmailMessage | undefined, action: 'confirm' | 'unsubscribe'): string {
  const match = new RegExp(String.raw`/subscribers/${action}\?token=([^\s&"<>]+)`, 'u').exec(mail?.text ?? '');
  if (match?.[1] === undefined) {
    throw new Error(`no ${action} link in the mail`);
  }
  return decodeURIComponent(match[1]);
}

describe('status subscribers (pglite)', () => {
  let t: TestDb;
  let clock: Date;
  let email: RecordingEmailSender;
  let status: StatusDomain;
  let subscribers: SubscriberService;
  let runner: JobRunner;
  let scope: StatusScope;
  let actor: string;

  /** Runs the runner's queue kicked, awaited by `drain`. */
  let kicked: Promise<unknown>[];

  /** Run every job that is due, and every kicked run, until nothing is left to run. */
  const drain = async (): Promise<void> => {
    const report = await runner.tick({ budgetMs: 60_000, maxJobs: 500 });
    expect(report.errors).toEqual([]);
    const running = [...kicked];
    kicked.length = 0;
    await Promise.all(running);
    if (report.ran > 0 || running.length > 0) {
      await drain();
    }
  };

  const deliveries = async () => await t.db.select().from(statusSubscriberDeliveries);
  const delivery = async (id: string) =>
    expectOne(await t.db.select().from(statusSubscriberDeliveries).where(eq(statusSubscriberDeliveries.id, id)));

  /** A page with two components. */
  const setUp = async (slug = 'acme') => {
    const page = await status.statusPages.createPage(scope, actor, { slug, title: 'Acme status' });
    const api = await status.statusPages.createComponent(scope, page.id, { name: 'API' });
    const web = await status.statusPages.createComponent(scope, page.id, { name: 'Dashboard' });
    return { page, api, web };
  };

  /** Subscribe and confirm from the confirmation mail. */
  const follow = async (
    slug: string,
    address: string,
    options: { componentIds?: string[]; locale?: 'en' | 'ko' } = {},
  ) => {
    await subscribers.subscribe(slug, { email: address, ...options });
    await drain();
    await subscribers.confirm(slug, tokenIn(email.to(address).at(-1), 'confirm'));
  };

  const openIncident = async (pageId: string, componentIds: string[], title = 'Elevated errors') =>
    await status.statusIncidents.create(scope, actor, {
      pageId,
      title,
      severity: IncidentSeverities.major,
      status: IncidentStatuses.investigating,
      body: 'We are looking into it.',
      components: componentIds.map(componentId => ({ componentId, impact: ComponentStatuses.partialOutage })),
    });

  /** The notice of an incident's latest update. */
  const noticeOf = async (incidentId: string): Promise<SubscriberNotice> => {
    const { updates } = await status.statusIncidents.get(scope, incidentId);
    const latest = updates.at(-1);
    if (latest === undefined) {
      throw new Error('the incident has no update');
    }
    return { kind: SubscriberMailKinds.incidentUpdate, ...scope, updateId: latest.id };
  };

  /** Open an incident and run its fan-out only, leaving the delivery queued. */
  const queuedUpdateMail = async (pageId: string) => {
    const incident = await openIncident(pageId, []);
    const notice = await noticeOf(incident.id);
    await subscribers.fanOut(notice);
    const rows = await deliveries();
    const queued = rows.find(row => row.dedupeKey === noticeKeyOf(notice));
    if (queued === undefined) {
      throw new Error('no delivery queued');
    }
    return queued;
  };

  /** The subjects of the mails sent to `address`. */
  const subjects = (address: string) => email.to(address).map(mail => mail.subject);

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    email = createRecordingEmailSender();
    kicked = [];
    const deps = { tokens: new SubscriberTokens('test-subscriber-key'), email };
    // Kicks are dropped: `drain` runs the jobs through the runner.
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => clock,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    status = createStatusDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      queue,
      appOrigin: APP_ORIGIN,
      subscribers: deps,
      now: () => clock,
    });
    if (status.statusSubscribers === undefined) {
      throw new Error('the status domain has no subscriber service');
    }
    subscribers = status.statusSubscribers;
    runner = createJobRunner(t.db, {
      now: () => clock,
      random: () => 0,
      workerId: 'test',
      waitUntil: promise => {
        kicked.push(promise);
      },
      appOrigin: APP_ORIGIN,
      discord: undefined,
      storage: undefined,
      statusSubscribers: deps,
    });
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
  });
  afterEach(async () => {
    await t.close();
  });

  it('sends an unconfirmed address only the confirmation mail', async () => {
    const { page } = await setUp();
    await subscribers.subscribe('acme', { email: 'pending@example.test' });
    await follow('acme', 'kim@example.test');

    const incident = await openIncident(page.id, []);
    await drain();
    await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.identified,
      body: 'A bad deploy.',
    });
    await drain();
    await status.statusMaintenances.schedule(scope, actor, {
      pageId: page.id,
      title: 'Database upgrade',
      body: 'Read-only for a few minutes.',
      scheduledStart: minutes(60),
      scheduledEnd: minutes(90),
      componentIds: [],
    });
    await drain();

    expect(subjects('pending@example.test')).toEqual(['Confirm your subscription to Acme status']);
    expect(subjects('kim@example.test')).toEqual([
      'Confirm your subscription to Acme status',
      '[Acme status] Investigating: Elevated errors',
      '[Acme status] Identified: Elevated errors',
      '[Acme status] Scheduled maintenance: Database upgrade',
    ]);
    // The confirmation carries its link and no unsubscribe header; the others the reverse.
    const [confirmation, , update] = email.to('kim@example.test');
    expect(confirmation?.headers).toBeUndefined();
    expect(update?.headers?.['List-Unsubscribe']).toMatch(
      /^<https:\/\/mocco\.test\/api\/ext\/v1\/status-pages\/acme\/subscribers\/unsubscribe\?token=/u,
    );
    expect(update?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(update?.text).toContain('A bad deploy.');
    // No delivery was ever queued for the pending address beyond its confirmation.
    const pending = expectOne(
      await t.db.select().from(statusSubscribers).where(eq(statusSubscribers.email, 'pending@example.test')),
    );
    const rows = await deliveries();
    expect(rows.filter(row => row.subscriberId === pending.id).map(row => row.kind)).toEqual([
      SubscriberMailKinds.confirmation,
    ]);
  });

  it('suppresses a queued mail when its subscriber has unsubscribed since', async () => {
    const { page } = await setUp();
    await follow('acme', 'kim@example.test');
    await openIncident(page.id, [], 'First');
    await drain();
    const sentBefore = email.mails.length;
    // The fan-out queues the mail; the subscriber leaves before it is sent.
    const queued = await queuedUpdateMail(page.id);
    await subscribers.unsubscribe('acme', tokenIn(email.to('kim@example.test').at(-1), 'unsubscribe'));
    await drain();

    expect(email.mails).toHaveLength(sentBefore);
    expect(await delivery(queued.id)).toMatchObject({ status: DeliveryStatuses.suppressed, error: 'unsubscribed' });
  });

  it('delivers an incident update at most once per subscriber, however often the fan-out and delivery run', async () => {
    const { page, api } = await setUp();
    await follow('acme', 'kim@example.test');
    await follow('acme', 'lee@example.test', { componentIds: [api.id] });
    const incident = await openIncident(page.id, [api.id]);
    const { update } = await status.statusIncidents.postUpdate(scope, actor, incident.id, {
      status: IncidentStatuses.monitoring,
      body: 'Fixed, watching.',
    });
    const notice: SubscriberNotice = { kind: SubscriberMailKinds.incidentUpdate, ...scope, updateId: update.id };

    // The queued fan-outs, then the same notice twice more.
    await drain();
    expect(await subscribers.fanOut(notice)).toEqual({ queued: 0 });
    expect(await subscribers.fanOut(notice)).toEqual({ queued: 0 });
    await drain();
    // And every delivery job once more.
    const queued = await deliveries();
    await queued.reduce(async (previous, row) => {
      await previous;
      await subscribers.deliver(row.id, { isFinalAttempt: false, now: clock });
    }, Promise.resolve());

    const monitoringMails = ['kim@example.test', 'lee@example.test'].map(
      address => subjects(address).filter(subject => subject === '[Acme status] Monitoring: Elevated errors').length,
    );
    expect(monitoringMails).toEqual([1, 1]);
    const settled = await deliveries();
    const ofUpdate = settled.filter(row => row.dedupeKey === `incident_update:${update.id}`);
    expect(ofUpdate).toHaveLength(2);
    expect(ofUpdate.every(row => row.status === DeliveryStatuses.sent && row.attempts === 1)).toBe(true);
  });

  it('gives a delivery whose sending run died up instead of sending it twice', async () => {
    const { page } = await setUp();
    await follow('acme', 'kim@example.test');
    const queued = await queuedUpdateMail(page.id);
    // A run claimed it and died.
    await t.db
      .update(statusSubscriberDeliveries)
      .set({ status: DeliveryStatuses.sending, sendingAt: clock })
      .where(eq(statusSubscriberDeliveries.id, queued.id));
    const sentBefore = email.mails.length;

    // While the claim is fresh another run may still be sending: wait for it.
    await expect(subscribers.deliver(queued.id, { isFinalAttempt: false, now: minutes(1) })).rejects.toBeInstanceOf(
      RetryAt,
    );
    await subscribers.deliver(queued.id, { isFinalAttempt: false, now: minutes(3) });

    expect(email.mails).toHaveLength(sentBefore);
    expect(await delivery(queued.id)).toMatchObject({
      status: DeliveryStatuses.failed,
      error: 'interrupted while sending; not sent again',
    });
  });

  it('retries a mail the relay put off, and fails one it refused', async () => {
    const { page } = await setUp();
    await follow('acme', 'kim@example.test');
    const queued = await queuedUpdateMail(page.id);
    email.next.push(
      { kind: EmailResultKinds.transient, reason: '421 try later' },
      { kind: EmailResultKinds.permanent, reason: '550 no such mailbox' },
    );

    await expect(subscribers.deliver(queued.id, { isFinalAttempt: false, now: clock })).rejects.toThrow(
      '421 try later',
    );
    expect(await delivery(queued.id)).toMatchObject({ status: DeliveryStatuses.queued, attempts: 1 });
    await subscribers.deliver(queued.id, { isFinalAttempt: false, now: clock });
    expect(await delivery(queued.id)).toMatchObject({
      status: DeliveryStatuses.failed,
      error: '550 no such mailbox',
      attempts: 2,
    });
  });

  it('sends each subscriber the notices about the components they chose', async () => {
    const { page, api, web } = await setUp();
    await follow('acme', 'all@example.test');
    await follow('acme', 'api@example.test', { componentIds: [api.id] });
    await openIncident(page.id, [web.id], 'Dashboard slow');
    await drain();
    await openIncident(page.id, [api.id], 'API errors');
    await drain();
    // About no component in particular: everyone.
    await openIncident(page.id, [], 'Login issues');
    await drain();

    expect(subjects('all@example.test').slice(1)).toEqual([
      '[Acme status] Investigating: Dashboard slow',
      '[Acme status] Investigating: API errors',
      '[Acme status] Investigating: Login issues',
    ]);
    expect(subjects('api@example.test').slice(1)).toEqual([
      '[Acme status] Investigating: API errors',
      '[Acme status] Investigating: Login issues',
    ]);
    expect(email.to('all@example.test')[1]?.text).toContain('Affects: Dashboard');
  });

  it("never sends a draft incident's updates", async () => {
    const { page } = await setUp();
    await follow('acme', 'kim@example.test');
    const incident = await openIncident(page.id, []);
    await t.db
      .update(statusIncidents)
      .set({ visibility: IncidentVisibilities.draft })
      .where(eq(statusIncidents.id, incident.id));
    await drain();

    expect(subjects('kim@example.test')).toEqual(['Confirm your subscription to Acme status']);
  });

  it('tells subscribers when a window is scheduled, starts and completes, in their language', async () => {
    const { page, api } = await setUp();
    await follow('acme', 'kim@example.test', { locale: SubscriberLocales.ko });
    await status.statusMaintenances.schedule(scope, actor, {
      pageId: page.id,
      title: 'DB upgrade',
      body: 'Read-only.',
      scheduledStart: minutes(10),
      scheduledEnd: minutes(40),
      componentIds: [api.id],
    });
    await drain();
    clock = minutes(10);
    await status.statusMaintenances.tick(clock);
    await drain();
    clock = minutes(40);
    await status.statusMaintenances.tick(clock);
    await drain();

    expect(subjects('kim@example.test')).toEqual([
      'Acme status 알림 구독을 확인해 주세요',
      '[Acme status] 점검 예정: DB upgrade',
      '[Acme status] 점검 진행 중: DB upgrade',
      '[Acme status] 점검 완료: DB upgrade',
    ]);
    expect(email.to('kim@example.test')[1]?.text).toContain('2026-10-06 09:10 UTC – 2026-10-06 09:40 UTC');
  });

  it('queues one confirmation per interval and leaves a confirmed address as it is', async () => {
    const { api } = await setUp();
    expect(await subscribers.subscribe('acme', { email: 'kim@example.test' })).toBe(
      SubscribeOutcomes.confirmationQueued,
    );
    expect(await subscribers.subscribe('acme', { email: 'kim@example.test' })).toBe(SubscribeOutcomes.throttled);
    clock = new Date(T0.getTime() + SubscriberPolicy.confirmationIntervalMs + 1000);
    expect(await subscribers.subscribe('acme', { email: 'kim@example.test' })).toBe(
      SubscribeOutcomes.confirmationQueued,
    );
    await drain();
    expect(subjects('kim@example.test')).toHaveLength(2);

    // Either link confirms; a stranger signing the address up again changes nothing.
    await subscribers.confirm('acme', tokenIn(email.to('kim@example.test')[0], 'confirm'));
    expect(await subscribers.subscribe('acme', { email: 'kim@example.test', componentIds: [api.id] })).toBe(
      SubscribeOutcomes.alreadySubscribed,
    );
    expect(expectOne(await t.db.select().from(statusSubscribers))).toMatchObject({
      componentIds: null,
      confirmedAt: clock,
    });
  });

  it('signs links that only do what they were issued for, on their own page, until they expire', async () => {
    const { page } = await setUp('acme');
    await setUp('other');
    await follow('acme', 'kim@example.test');
    await subscribers.subscribe('acme', { email: 'lee@example.test' });
    await drain();
    const confirm = tokenIn(email.to('lee@example.test')[0], 'confirm');
    const refused = async (run: () => Promise<unknown>) => {
      await expect(run()).rejects.toBeInstanceOf(SubscriberTokenError);
    };

    // A confirmation link can't unsubscribe.
    await refused(async () => await subscribers.unsubscribe('acme', confirm));
    await refused(async () => await subscribers.describeUnsubscribe('acme', confirm));
    // Nor confirm on another page, or with one character changed, or for another subscriber.
    await refused(async () => await subscribers.confirm('other', confirm));
    const changed = `${confirm.slice(0, -1)}${confirm.endsWith('A') ? 'B' : 'A'}`;
    await refused(async () => await subscribers.confirm('acme', changed));
    await refused(async () => await subscribers.confirm('acme', 'not-a-token'));
    const kim = expectOne(
      await t.db.select().from(statusSubscribers).where(eq(statusSubscribers.email, 'kim@example.test')),
    );
    await refused(async () => await subscribers.confirm('acme', `${kim.id}${confirm.slice(36)}`));
    // After a week it has expired.
    clock = new Date(T0.getTime() + CONFIRM_TOKEN_TTL_MS + 1000);
    await refused(async () => await subscribers.confirm('acme', confirm));
    clock = T0;
    await subscribers.confirm('acme', confirm);

    // The unsubscribe link in a mail can't confirm, and unsubscribes only its subscriber.
    await openIncident(page.id, []);
    await drain();
    const unsubscribe = tokenIn(email.to('kim@example.test').at(-1), 'unsubscribe');
    await refused(async () => await subscribers.confirm('acme', unsubscribe));
    await refused(async () => await subscribers.unsubscribe('other', unsubscribe));
    expect(await subscribers.describeUnsubscribe('acme', unsubscribe)).toEqual({
      pageTitle: 'Acme status',
      locale: SubscriberLocales.en,
    });
    await subscribers.unsubscribe('acme', unsubscribe);
    await subscribers.unsubscribe('acme', unsubscribe);
    const rows = await t.db.select().from(statusSubscribers);
    expect(Object.fromEntries(rows.map(row => [row.email, row.unsubscribedAt]))).toEqual({
      'kim@example.test': T0,
      'lee@example.test': null,
    });
    // An old confirmation link can't bring an unsubscribed address back.
    await refused(async () => await subscribers.confirm('acme', tokenIn(email.to('kim@example.test')[0], 'confirm')));
  });

  it('prunes sign-ups never confirmed once their link expired, and old settled deliveries', async () => {
    await setUp();
    await subscribers.subscribe('acme', { email: 'pending@example.test' });
    await follow('acme', 'kim@example.test');
    // `created_at` is the database's own clock, not the test's: leave two days of room either side.
    const later = new Date(T0.getTime() + SubscriberPolicy.deliveryRetentionMs + 2 * 24 * 60 * 60 * 1000);

    expect(await subscribers.prune(later)).toEqual({ subscribers: 1, deliveries: 1 });
    const left = await t.db.select().from(statusSubscribers);
    expect(left.map(row => row.email)).toEqual(['kim@example.test']);
  });
});
