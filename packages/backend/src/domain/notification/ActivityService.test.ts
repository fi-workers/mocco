import { randomUUID } from 'node:crypto';

import { DomainEventTypes } from '@mocco/common/events';
import { InboundKinds, InboundOutcomes, type InboundKind } from '@mocco/common/inbound';
import { DeliveryStatuses } from '@mocco/common/notification';
import { ActivityChannelResultKinds, ActivityItemKinds } from '@mocco/common/notification-activity';
import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventBus } from '@backend/domain/events/subscriptions';
import { InboundReceiptRepo } from '@backend/domain/inbound/repos/inbound-receipt.repo';
import { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import { createInboundHarness, ingestKeyOf, signedDelivery } from '@backend/domain/inbound/testing/harness';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { ActivityService } from '@backend/domain/notification/ActivityService';
import { NotificationSubscribers } from '@backend/domain/notification/constants';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { RuleRepo } from '@backend/domain/notification/repos/rule.repo';
import { seedChannel, seedRule, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { inboundReceipts, notificationChannels, notificationDeliveries } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { ActivityItemDto } from '@mocco/common/notification-activity';

const SUBSCRIBER: Record<InboundKind, string> = {
  [InboundKinds.sentry]: NotificationSubscribers.sentry.name,
  [InboundKinds.vercel]: NotificationSubscribers.vercel.name,
  [InboundKinds.github]: NotificationSubscribers.github.name,
};

const channelOf = (item: ActivityItemDto | undefined, channelId: string) =>
  item?.channels.find(result => result.channelId === channelId);

const query = (overrides: Partial<Parameters<ActivityService['list']>[1]> = {}) => ({ limit: 25, ...overrides });

describe('ActivityService (pglite)', () => {
  let t: TestDb;
  let bus: EventBus;
  let clock: number;
  // Every call is a second later, starting a day after the real clock: events are
  // ordered, and channels seeded before them (a DB-default created_at, which a local
  // session time zone can shift by hours) are older.
  const now = () => {
    clock += 1000;
    return new Date(clock);
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = Date.now() + 86_400_000;
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    bus = createEventBus({ db: t.db, queue, now, appOrigin: 'https://www.mocco.test' });
  });
  afterEach(async () => {
    await t.close();
  });

  const service = () =>
    new ActivityService({
      receipts: new InboundReceiptRepo(t.db),
      sources: new InboundSourceRepo(t.db),
      channels: new ChannelRepo(t.db),
      rules: new RuleRepo(t.db),
      deliveries: new DeliveryRepo(t.db),
    });

  /** A source of `kind` and a function that ingests one signed delivery and fans it out. */
  const source = async (workspaceId: string, kind: InboundKind) => {
    const h = createInboundHarness(t.db, { now, bus });
    const pasted = kind === InboundKinds.github ? undefined : `${kind}-secret`;
    const created = await h.sources.create(workspaceId, { kind, name: `${kind} source`, secret: pasted });
    const secret = created.generatedSecret ?? pasted ?? '';
    const ingest = async (patch?: (delivery: ReturnType<typeof signedDelivery>) => void) => {
      const delivery = signedDelivery(kind, secret);
      patch?.(delivery);
      await h.inbound.ingest({ ingestKey: ingestKeyOf(created.source.ingestUrl), ...delivery });
      const [receipt] = await t.db
        .select()
        .from(inboundReceipts)
        .where(eq(inboundReceipts.sourceId, created.source.id))
        .orderBy(desc(inboundReceipts.seq))
        .limit(1);
      if (receipt?.domainEventId) {
        await bus.deliver(receipt.domainEventId, SUBSCRIBER[kind]);
      }
      return receipt;
    };
    return { source: created.source, ingest };
  };

  const gatePending = async (workspaceId: string) => {
    const runId = randomUUID();
    const { event } = await bus.publish({
      type: DomainEventTypes.gatePending,
      workspaceId,
      subject: { type: 'run_gate', id: randomUUID() },
      payload: {
        workspaceId,
        runId,
        repoFullName: 'acme/web',
        pipelineName: 'deploy',
        commitSha: 'abc1234',
        linkPath: `/workspaces/${workspaceId}/runs/${runId}`,
        gateName: 'production',
        gateItemIndex: 1,
        facts: { repo: 'acme/web', pipeline: 'deploy', gate: 'production' },
      },
    });
    await bus.deliver(event.id, NotificationSubscribers.gate.name);
    return event;
  };

  it('joins a receipt with its event and every channel: a delivery, a rule mismatch and a disabled channel', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const deploys = await seedChannel(t.db, workspaceId, 'deploys');
    const previews = await seedChannel(t.db, workspaceId, 'previews');
    const broken = await seedChannel(t.db, workspaceId, 'broken');
    await seedRule(t.db, deploys, { eventType: 'vercel.deployment.succeeded', filter: { target: 'production' } });
    await seedRule(t.db, previews, { eventType: 'vercel.deployment.succeeded', filter: { target: 'preview' } });
    await seedRule(t.db, broken, { eventType: 'vercel.*' });
    await new ChannelRepo(t.db).disable(workspaceId, broken.id, 'Missing Access (50001)');
    const vercel = await source(workspaceId, InboundKinds.vercel);
    const receipt = await vercel.ingest();

    const { items, nextCursor } = await service().list(workspaceId, query());

    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({
      kind: ActivityItemKinds.receipt,
      id: receipt?.id,
      seq: receipt?.seq.toString(),
      outcome: InboundOutcomes.published,
      eventType: 'vercel.deployment.succeeded',
      eventId: receipt?.domainEventId,
      source: { id: vercel.source.id, name: 'vercel source', kind: InboundKinds.vercel },
    });
    expect(channelOf(item, deploys.id)).toMatchObject({
      kind: ActivityChannelResultKinds.delivery,
      channelName: 'deploys',
      delivery: { status: DeliveryStatuses.queued, attempts: 0 },
    });
    expect(channelOf(item, previews.id)).toEqual({
      kind: ActivityChannelResultKinds.no_match,
      channelId: previews.id,
      channelName: 'previews',
      reason: 'rule `vercel.deployment.succeeded` needs target = "preview" (the event has "production")',
    });
    expect(channelOf(item, broken.id)).toEqual({
      kind: ActivityChannelResultKinds.channel_disabled,
      channelId: broken.id,
      channelName: 'broken',
      reason: 'Missing Access (50001)',
    });
  });

  it('shows ignored and over-quota receipts with their reason and no channels', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel, { eventType: 'github.*' });
    const github = await source(workspaceId, InboundKinds.github);
    await github.ingest(delivery => {
      delivery.headers.set('x-github-event', 'ping');
    });
    await new InboundReceiptRepo(t.db).insertIfNew({
      workspaceId,
      sourceId: github.source.id,
      externalId: 'dropped',
      sourceEvent: 'push',
      outcome: InboundOutcomes.over_quota,
      reason: 'workspace is over the daily limit of 5000 events',
      eventType: 'github.push',
      normalized: null,
      receivedAt: now(),
    });

    const { items } = await service().list(workspaceId, query());

    expect(items.map(item => [item.outcome, item.reason, item.channels])).toEqual([
      [InboundOutcomes.over_quota, 'workspace is over the daily limit of 5000 events', []],
      [InboundOutcomes.ignored, expect.any(String), []],
    ]);
  });

  it('explains a channel added after the event, and a channel with no rules', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const empty = await seedChannel(t.db, workspaceId, 'empty');
    const sentry = await source(workspaceId, InboundKinds.sentry);
    await sentry.ingest();
    const later = await seedChannel(t.db, workspaceId, 'later');
    await t.db
      .update(notificationChannels)
      .set({ createdAt: new Date(clock + 3_600_000) })
      .where(eq(notificationChannels.id, later.id));

    const { items } = await service().list(workspaceId, query());
    const [item] = items;

    expect(channelOf(item, empty.id)).toMatchObject({
      kind: ActivityChannelResultKinds.no_match,
      reason: 'the channel has no rules',
    });
    expect(channelOf(item, later.id)).toMatchObject({ kind: ActivityChannelResultKinds.channel_added_later });
  });

  it('includes Mocco events that were delivered, merged with receipts newest first', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel, { eventType: 'gate.*' });
    await seedRule(t.db, channel, { eventType: 'sentry.*' });
    const sentry = await source(workspaceId, InboundKinds.sentry);
    await sentry.ingest();
    const gate = await gatePending(workspaceId);
    await sentry.ingest();
    // A Mocco event no channel wanted is not activity.
    await bus.publish({
      type: DomainEventTypes.runSucceeded,
      workspaceId,
      subject: { type: 'run', id: randomUUID() },
      payload: {
        workspaceId,
        runId: randomUUID(),
        repoFullName: 'acme/web',
        pipelineName: 'deploy',
        commitSha: 'abc1234',
        linkPath: '/workspaces/x/runs/y',
        facts: { repo: 'acme/web', pipeline: 'deploy' },
      },
    });

    const { items } = await service().list(workspaceId, query());

    expect(items.map(item => [item.kind, item.eventType])).toEqual([
      [ActivityItemKinds.receipt, 'sentry.issue.created'],
      [ActivityItemKinds.event, 'gate.pending'],
      [ActivityItemKinds.receipt, 'sentry.issue.created'],
    ]);
    expect(items[1]).toMatchObject({ id: gate.id, source: null, outcome: null, seq: null });
    expect(channelOf(items[1], channel.id)).toMatchObject({ kind: ActivityChannelResultKinds.delivery });
    // A source filter is receipts only.
    const filtered = await service().list(workspaceId, query({ sourceId: sentry.source.id }));
    expect(filtered.items.map(item => item.kind)).toEqual([ActivityItemKinds.receipt, ActivityItemKinds.receipt]);
  });

  it('paginates the merged streams without skipping or repeating a row', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel, { eventType: 'gate.*' });
    await seedRule(t.db, channel, { eventType: 'github.*' });
    const github = await source(workspaceId, InboundKinds.github);
    const expected: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      // Interleave the two streams unevenly: receipts, then a gate every third row.
      // eslint-disable-next-line no-await-in-loop -- ordered on purpose: each row is a second later
      const row = index % 3 === 1 ? await gatePending(workspaceId) : await github.ingest();
      expected.unshift(row?.id ?? '');
    }

    const seen: string[] = [];
    let cursor: Parameters<ActivityService['list']>[1]['cursor'];
    let pages = 0;
    do {
      // eslint-disable-next-line no-await-in-loop -- each page needs the previous cursor
      const page = await service().list(workspaceId, query({ limit: 3, cursor }));
      seen.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
  });

  it('filters by channel and outcome, and never shows another workspace', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const other = await seedWorkspace(t.db, 'other');
    const a = await seedChannel(t.db, workspaceId, 'a');
    const b = await seedChannel(t.db, workspaceId, 'b');
    await seedRule(t.db, a, { eventType: 'gate.*' });
    await seedRule(t.db, b, { eventType: 'sentry.*' });
    const sentry = await source(workspaceId, InboundKinds.sentry);
    await sentry.ingest();
    await gatePending(workspaceId);
    const foreign = await source(other, InboundKinds.sentry);
    await foreign.ingest();

    const onlyB = await service().list(workspaceId, query({ channelId: b.id }));
    // The gate went to `a` only, so it is not activity of `b`; the receipt shows `b` alone.
    expect(onlyB.items.map(item => item.kind)).toEqual([ActivityItemKinds.receipt]);
    expect(onlyB.items[0]?.channels.map(result => result.channelId)).toEqual([b.id]);

    const ignored = await service().list(workspaceId, query({ outcome: InboundOutcomes.ignored }));
    expect(ignored.items).toEqual([]);

    const all = await service().list(workspaceId, query());
    expect(all.items).toHaveLength(2);
    expect(all.items.every(item => item.source === null || item.source.id === sentry.source.id)).toBe(true);
  });

  it('lists a delivery whose channel was deleted without a channel', async () => {
    const workspaceId = await seedWorkspace(t.db);
    const channel = await seedChannel(t.db, workspaceId);
    await seedRule(t.db, channel, { eventType: 'gate.*' });
    const gate = await gatePending(workspaceId);
    await t.db
      .update(notificationDeliveries)
      .set({ status: DeliveryStatuses.failed, error: 'Missing Permissions (50013)', responseCode: 403 })
      .where(eq(notificationDeliveries.eventId, gate.id));
    await new ChannelRepo(t.db).delete(workspaceId, channel.id);

    const { items } = await service().list(workspaceId, query());
    const [item] = items;

    expect(item?.channels).toEqual([
      {
        kind: ActivityChannelResultKinds.delivery,
        channelId: null,
        channelName: null,
        delivery: expect.objectContaining({
          status: DeliveryStatuses.failed,
          error: 'Missing Permissions (50013)',
          responseCode: 403,
        }),
      },
    ]);
  });
});
