import { randomUUID } from 'node:crypto';

import { InboundKinds, InboundOutcomes, type InboundKind, type InboundOutcome } from '@mocco/common/inbound';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DomainEventPayloadError } from '@backend/domain/events/errors';
import { createTestEventBus, FailingEventPublisher } from '@backend/domain/events/testing/event-bus';
import {
  INBOUND_DAILY_LIMIT,
  INBOUND_HARD_LIMIT,
  INBOUND_MAX_PUBLISH_ATTEMPTS,
  IngestOutcomes,
  IngestStatuses,
} from '@backend/domain/inbound/constants';
import { InboundService } from '@backend/domain/inbound/InboundService';
import { InboundReceiptRepo } from '@backend/domain/inbound/repos/inbound-receipt.repo';
import { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import { IgnoredReasons } from '@backend/domain/inbound/sources/shared';
import { encode, readFixture } from '@backend/domain/inbound/testing/fixtures';
import {
  createInboundHarness,
  ingestKeyOf,
  insertWorkspace,
  signedDelivery,
} from '@backend/domain/inbound/testing/harness';
import { domainEvents, inboundReceipts, inboundSources, jobs } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { EventPublisher } from '@backend/domain/events/ports';
import type { Db } from '@backend/infra/db/types';

const KINDS: InboundKind[] = [InboundKinds.sentry, InboundKinds.vercel, InboundKinds.github];
const T0 = new Date('2026-09-25T12:00:00.000Z');

const FILL_CHUNK = 5000;

/** `count` receipts of a source with `outcome`, all received at `receivedAt`, inserted in
 * chunks (one statement has a bind-parameter limit). */
async function fillReceipts(
  db: Db,
  source: { id: string; workspaceId: string },
  count: number,
  receivedAt: Date,
  outcome: InboundOutcome = InboundOutcomes.published,
) {
  const chunks = Array.from({ length: Math.ceil(count / FILL_CHUNK) }, (_, chunk) => chunk);
  await chunks.reduce(async (previous, chunk) => {
    await previous;
    const size = Math.min(FILL_CHUNK, count - chunk * FILL_CHUNK);
    await db.insert(inboundReceipts).values(
      Array.from({ length: size }, (_, index) => ({
        workspaceId: source.workspaceId,
        sourceId: source.id,
        externalId: `old-${chunk}-${index}`,
        outcome,
        receivedAt,
      })),
    );
  }, Promise.resolve());
}

describe('InboundService.ingest on pglite', () => {
  let t: TestDb;
  let clock: Date;
  const now = () => clock;

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const harness = (bus?: EventPublisher) => createInboundHarness(t.db, { now, bus });

  /** A source of `kind` in a new workspace, with the plaintext secret the vendor signs with. */
  const setup = async (kind: InboundKind, options: { bus?: EventPublisher; workspace?: string } = {}) => {
    const h = harness(options.bus);
    const workspaceId = options.workspace ?? (await insertWorkspace(t.db, `ws-${randomUUID()}`));
    const pasted = kind === InboundKinds.github ? undefined : `${kind}-secret-${randomUUID()}`;
    const { source, generatedSecret } = await h.sources.create(workspaceId, {
      kind,
      name: `${kind} source`,
      secret: pasted,
    });
    const secret = generatedSecret ?? pasted ?? '';
    return { ...h, workspaceId, source, secret, ingestKey: ingestKeyOf(source.ingestUrl) };
  };

  const counts = async () => {
    const receipts = await t.db.select().from(inboundReceipts);
    const events = await t.db.select().from(domainEvents);
    const queued = await t.db.select().from(jobs);
    return { receipts: receipts.length, events: events.length, jobs: queued.length };
  };

  describe.each(KINDS)('%s', kind => {
    it('publishes a signed delivery and links the receipt to its event', async () => {
      const { inbound, source, secret, ingestKey, workspaceId } = await setup(kind);

      const result = await inbound.ingest({ ingestKey, ...signedDelivery(kind, secret, { deliveryId: 'd-1' }) });

      expect(result).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.published });
      const [receipt] = await t.db.select().from(inboundReceipts);
      const [event] = await t.db.select().from(domainEvents);
      expect(receipt).toMatchObject({
        workspaceId,
        sourceId: source.id,
        externalId: 'd-1',
        outcome: InboundOutcomes.published,
        domainEventId: event?.id,
        receivedAt: T0,
      });
      expect(event).toMatchObject({
        workspaceId,
        type: receipt?.eventType,
        subjectType: 'inbound_receipt',
        subjectId: receipt?.id,
        dedupeKey: `inbound:${receipt?.id}`,
        occurredAt: T0,
      });
      expect(event?.payload).toMatchObject({ sourceId: source.id });
      expect(event?.payload).toEqual(receipt?.normalized);
      const [row] = await t.db.select().from(inboundSources).where(eq(inboundSources.id, source.id));
      expect(row?.lastReceivedAt).toEqual(T0);
    });

    it('rejects a bad signature with 401 and writes nothing', async () => {
      const { inbound, ingestKey } = await setup(kind);
      const before = await counts();

      const result = await inbound.ingest({ ingestKey, ...signedDelivery(kind, 'x', { signWith: 'wrong-secret' }) });

      expect(result).toEqual({ status: IngestStatuses.unauthorized });
      expect(await counts()).toEqual(before);
      const [row] = await t.db.select().from(inboundSources);
      expect(row?.lastReceivedAt).toBeNull();
    });

    it('rejects an unsigned delivery with 401 and writes nothing', async () => {
      const { inbound, ingestKey, secret } = await setup(kind);
      const delivery = signedDelivery(kind, secret);
      const headers = new Headers(delivery.headers);
      headers.delete('sentry-hook-signature');
      headers.delete('x-vercel-signature');
      headers.delete('x-hub-signature-256');

      expect(await inbound.ingest({ ingestKey, body: delivery.body, headers })).toEqual({
        status: IngestStatuses.unauthorized,
      });
      expect(await counts()).toMatchObject({ receipts: 0 });
    });

    it('answers 400 without a delivery id', async () => {
      const { inbound, ingestKey, secret } = await setup(kind);

      const result = await inbound.ingest({ ingestKey, ...signedDelivery(kind, secret, { withoutDeliveryId: true }) });

      expect(result).toEqual({ status: IngestStatuses.badRequest });
      expect(await counts()).toMatchObject({ receipts: 0 });
    });

    it('records a redelivery once and publishes once', async () => {
      const { inbound, ingestKey, secret } = await setup(kind);
      const delivery = signedDelivery(kind, secret, { deliveryId: 'same' });

      const first = await inbound.ingest({ ingestKey, ...delivery });
      const second = await inbound.ingest({ ingestKey, ...delivery });

      expect(first).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.published });
      expect(second).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.duplicate });
      expect(await counts()).toMatchObject({ receipts: 1 });
      expect(await counts()).toMatchObject({ events: 1 });
    });
  });

  it('answers 404 for an unknown ingest key and a paused source, writing nothing', async () => {
    const { inbound, sources, source, secret, ingestKey, workspaceId } = await setup(InboundKinds.sentry);
    const delivery = signedDelivery(InboundKinds.sentry, secret);

    expect(await inbound.ingest({ ingestKey: 'no-such-key', ...delivery })).toEqual({
      status: IngestStatuses.notFound,
    });
    await sources.pause(workspaceId, source.id);
    expect(await inbound.ingest({ ingestKey, ...delivery })).toEqual({ status: IngestStatuses.notFound });
    expect(await counts()).toEqual({ receipts: 0, events: 0, jobs: 0 });

    await sources.resume(workspaceId, source.id);
    expect(await inbound.ingest({ ingestKey, ...delivery })).toMatchObject({ status: IngestStatuses.accepted });
  });

  it('records an unmapped delivery as ignored with the adapter reason, and publishes nothing', async () => {
    const { inbound, ingestKey, secret } = await setup(InboundKinds.sentry);
    const body = encode(readFixture('sentry/issue-resolved.json'));

    const result = await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret, { body }) });

    expect(result).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.ignored });
    const [receipt] = await t.db.select().from(inboundReceipts);
    expect(receipt).toMatchObject({
      outcome: InboundOutcomes.ignored,
      reason: 'sentry action "resolved" is not mapped',
      sourceEvent: 'issue.resolved',
      eventType: null,
      normalized: null,
      domainEventId: null,
    });
    expect(await counts()).toMatchObject({ events: 0 });
  });

  it('records a GitHub ping as ignored', async () => {
    const { inbound, ingestKey, secret } = await setup(InboundKinds.github);
    const delivery = signedDelivery(InboundKinds.github, secret, { body: encode(readFixture('github/ping.json')) });
    delivery.headers.set('x-github-event', 'ping');

    expect(await inbound.ingest({ ingestKey, ...delivery })).toEqual({
      status: IngestStatuses.accepted,
      outcome: IngestOutcomes.ignored,
    });
    const [receipt] = await t.db.select().from(inboundReceipts);
    expect(receipt).toMatchObject({ reason: 'ping', sourceEvent: 'ping' });
  });

  it('records a signed body that is not valid UTF-8 as ignored', async () => {
    const { inbound, ingestKey, secret } = await setup(InboundKinds.github);
    const text = encode(readFixture('github/push.json'));
    const body = new Uint8Array([...text.slice(0, 10), 0xff, ...text.slice(10)]);

    const result = await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.github, secret, { body }) });

    expect(result).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.ignored });
    const [receipt] = await t.db.select().from(inboundReceipts);
    expect(receipt).toMatchObject({ reason: IgnoredReasons.invalidUtf8, sourceEvent: null });
  });

  it('verifies a BOM-prefixed body over its exact bytes and publishes it', async () => {
    const { inbound, ingestKey, secret } = await setup(InboundKinds.github);
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(readFixture('github/push.json'))]);

    const result = await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.github, secret, { body }) });

    expect(result).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.published });
  });

  describe('quota', () => {
    it(`records a delivery past ${INBOUND_DAILY_LIMIT} published in 24h as over_quota`, async () => {
      const { inbound, ingestKey, secret, source, workspaceId } = await setup(InboundKinds.sentry);
      await fillReceipts(
        t.db,
        { id: source.id, workspaceId },
        INBOUND_DAILY_LIMIT,
        new Date(T0.getTime() - 60 * 60 * 1000),
      );

      const result = await inbound.ingest({
        ingestKey,
        ...signedDelivery(InboundKinds.sentry, secret, { deliveryId: 'x' }),
      });

      expect(result).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.over_quota });
      const [receipt] = await t.db.select().from(inboundReceipts).where(eq(inboundReceipts.externalId, 'x'));
      expect(receipt).toMatchObject({
        outcome: InboundOutcomes.over_quota,
        reason: `workspace is over the daily limit of ${INBOUND_DAILY_LIMIT} events`,
        domainEventId: null,
      });
      expect(await counts()).toMatchObject({ events: 0 });
    });

    it('publishes again once the published receipts are older than 24 hours', async () => {
      const { inbound, ingestKey, secret, source, workspaceId } = await setup(InboundKinds.sentry);
      await fillReceipts(
        t.db,
        { id: source.id, workspaceId },
        INBOUND_DAILY_LIMIT,
        new Date(T0.getTime() - 25 * 60 * 60 * 1000),
      );

      const result = await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });

      expect(result).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.published });
    });

    it('counts per workspace: another workspace over quota does not limit this one', async () => {
      const busy = await setup(InboundKinds.sentry);
      await fillReceipts(t.db, { id: busy.source.id, workspaceId: busy.workspaceId }, INBOUND_DAILY_LIMIT, T0);
      const quiet = await setup(InboundKinds.sentry);

      const result = await quiet.inbound.ingest({
        ingestKey: quiet.ingestKey,
        ...signedDelivery(InboundKinds.sentry, quiet.secret),
      });

      expect(result).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.published });
    });
  });

  it('keeps tenants apart: a delivery to A never publishes for B, and B’s secret never verifies for A', async () => {
    const a = await setup(InboundKinds.github);
    const b = await setup(InboundKinds.github);

    expect(
      await a.inbound.ingest({
        ingestKey: a.ingestKey,
        ...signedDelivery(InboundKinds.github, a.secret, { deliveryId: 'shared' }),
      }),
    ).toMatchObject({ outcome: IngestOutcomes.published });
    // The same delivery id at B is B's own delivery, not a duplicate of A's.
    expect(
      await b.inbound.ingest({
        ingestKey: b.ingestKey,
        ...signedDelivery(InboundKinds.github, b.secret, { deliveryId: 'shared' }),
      }),
    ).toMatchObject({ outcome: IngestOutcomes.published });
    // Signed with B's secret but sent to A's URL: rejected, nothing written for either.
    expect(
      await a.inbound.ingest({ ingestKey: a.ingestKey, ...signedDelivery(InboundKinds.github, b.secret) }),
    ).toEqual({ status: IngestStatuses.unauthorized });

    const events = await t.db.select().from(domainEvents);
    expect(events).toHaveLength(2);
    expect(new Set(events.map(event => event.workspaceId))).toEqual(new Set([a.workspaceId, b.workspaceId]));
    const receipts = await t.db.select().from(inboundReceipts);
    expect(receipts.find(receipt => receipt.sourceId === a.source.id)?.workspaceId).toBe(a.workspaceId);
    expect(receipts.find(receipt => receipt.sourceId === b.source.id)?.workspaceId).toBe(b.workspaceId);
    const aEvents = events.filter(event => event.workspaceId === a.workspaceId);
    expect(aEvents.map(event => (event.payload as { sourceId: string }).sourceId)).toEqual([a.source.id]);
  });

  describe('publish failures and republish-stale', () => {
    it('keeps the receipt pending and still accepts when the bus fails', async () => {
      const failing = new FailingEventPublisher();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { inbound, ingestKey, secret } = await setup(InboundKinds.sentry, { bus: failing });

      const result = await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });

      expect(result).toEqual({ status: IngestStatuses.accepted, outcome: IngestOutcomes.pending });
      expect(failing.attempts).toBe(1);
      const [receipt] = await t.db.select().from(inboundReceipts);
      expect(receipt?.outcome).toBe(InboundOutcomes.pending);
      expect(receipt?.normalized).not.toBeNull();
    });

    it('republishes pending receipts older than 60 seconds, with the same dedupe key', async () => {
      const failing = new FailingEventPublisher();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const broken = await setup(InboundKinds.sentry, { bus: failing });
      await broken.inbound.ingest({
        ingestKey: broken.ingestKey,
        ...signedDelivery(InboundKinds.sentry, broken.secret),
      });
      const healthy = harness();

      clock = new Date(T0.getTime() + 30 * 1000);
      expect(await healthy.inbound.republishStale()).toBe(0);

      clock = new Date(T0.getTime() + 61 * 1000);
      expect(await healthy.inbound.republishStale()).toBe(1);

      const [receipt] = await t.db.select().from(inboundReceipts);
      const [event] = await t.db.select().from(domainEvents);
      expect(receipt).toMatchObject({ outcome: InboundOutcomes.published, domainEventId: event?.id });
      expect(event).toMatchObject({ dedupeKey: `inbound:${receipt?.id}`, occurredAt: T0 });
      // Nothing left to do.
      expect(await healthy.inbound.republishStale()).toBe(0);
    });

    it('does not publish twice when a republish races an original that already published', async () => {
      const { inbound, ingestKey, secret } = await setup(InboundKinds.sentry);
      await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });
      // Simulate the original crashing after its publish but before marking the receipt.
      await t.db.update(inboundReceipts).set({ outcome: InboundOutcomes.pending, domainEventId: null });

      clock = new Date(T0.getTime() + 120 * 1000);
      expect(await inbound.republishStale()).toBe(1);

      const events = await t.db.select().from(domainEvents);
      expect(events).toHaveLength(1);
      const [receipt] = await t.db.select().from(inboundReceipts);
      expect(receipt).toMatchObject({ outcome: InboundOutcomes.published, domainEventId: events[0]?.id });
    });

    it(`gives up on a receipt after ${INBOUND_MAX_PUBLISH_ATTEMPTS} failed publishes`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = new FailingEventPublisher();
      const { inbound, ingestKey, secret } = await setup(InboundKinds.sentry, { bus: failing });
      await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });

      clock = new Date(T0.getTime() + 120 * 1000);
      // The ingest was attempt 1; each republish adds one.
      await Array.from({ length: INBOUND_MAX_PUBLISH_ATTEMPTS - 1 }).reduce<Promise<void>>(async previous => {
        await previous;
        await inbound.republishStale();
      }, Promise.resolve());

      expect(failing.attempts).toBe(INBOUND_MAX_PUBLISH_ATTEMPTS);
      const [receipt] = await t.db.select().from(inboundReceipts);
      expect(receipt).toMatchObject({
        outcome: InboundOutcomes.ignored,
        reason: `publishing failed ${INBOUND_MAX_PUBLISH_ATTEMPTS} times`,
        publishAttempts: INBOUND_MAX_PUBLISH_ATTEMPTS,
      });
      expect(await inbound.republishStale()).toBe(0);
      expect(failing.attempts).toBe(INBOUND_MAX_PUBLISH_ATTEMPTS);
    });

    it('marks a receipt ignored at once when the bus rejects its payload as invalid', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const rejecting: EventPublisher = {
        publish: async () => await Promise.reject(new DomainEventPayloadError('sentry.issue.created')),
      };
      const { inbound, ingestKey, secret } = await setup(InboundKinds.sentry, { bus: rejecting });

      await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });

      const [receipt] = await t.db.select().from(inboundReceipts);
      expect(receipt).toMatchObject({ outcome: InboundOutcomes.ignored, publishAttempts: 1 });
    });

    it('scans the fewest failed publishes first, so failing receipts never starve newer ones', async () => {
      const { source, workspaceId } = await setup(InboundKinds.sentry);
      const pending = (externalId: string, publishAttempts: number, receivedAt: Date) => ({
        workspaceId,
        sourceId: source.id,
        externalId,
        outcome: InboundOutcomes.pending,
        publishAttempts,
        receivedAt,
      });
      await t.db
        .insert(inboundReceipts)
        .values([
          pending('old-failing', 3, new Date(T0.getTime() - 60 * 60 * 1000)),
          pending('new', 0, new Date(T0.getTime() - 5 * 60 * 1000)),
          pending('older-new', 0, new Date(T0.getTime() - 10 * 60 * 1000)),
        ]);

      const scanned = await new InboundReceiptRepo(t.db).listPendingBefore(T0, 2);

      expect(scanned.map(receipt => receipt.externalId)).toEqual(['older-new', 'new']);
    });

    it('marks a stored payload that no longer parses as ignored instead of retrying forever', async () => {
      const { inbound, source, workspaceId } = await setup(InboundKinds.sentry);
      await t.db.insert(inboundReceipts).values({
        workspaceId,
        sourceId: source.id,
        externalId: 'broken',
        outcome: InboundOutcomes.pending,
        eventType: 'sentry.issue.created',
        normalized: { sourceId: source.id },
        receivedAt: T0,
      });

      clock = new Date(T0.getTime() + 120 * 1000);
      await inbound.republishStale();

      const [receipt] = await t.db.select().from(inboundReceipts);
      expect(receipt).toMatchObject({
        outcome: InboundOutcomes.ignored,
        reason: 'stored event no longer matches the event catalog',
      });
    });
  });

  describe('hard ceiling', () => {
    it(`refuses with 429 and writes nothing once the workspace has ${INBOUND_HARD_LIMIT} receipts in 24h`, async () => {
      const warnings: unknown[] = [];
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
      const { inbound, ingestKey, secret, source, workspaceId } = await setup(InboundKinds.sentry);
      await fillReceipts(t.db, { id: source.id, workspaceId }, INBOUND_HARD_LIMIT, T0, InboundOutcomes.ignored);
      const before = await counts();

      const first = await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });
      const second = await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });

      expect(first).toEqual({ status: IngestStatuses.tooManyRequests });
      expect(second).toEqual({ status: IngestStatuses.tooManyRequests });
      expect(await counts()).toEqual(before);
      // Logged once per workspace per window, not once per refused delivery.
      expect(warnings).toHaveLength(1);

      // A day later the window has moved on.
      clock = new Date(T0.getTime() + 25 * 60 * 60 * 1000);
      expect(await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) })).toMatchObject({
        status: IngestStatuses.accepted,
      });
    });
  });

  describe('last_received_at', () => {
    it('is written at most once a minute per source', async () => {
      const { inbound, ingestKey, secret, source } = await setup(InboundKinds.sentry);
      const lastReceived = async () => {
        const [row] = await t.db.select().from(inboundSources).where(eq(inboundSources.id, source.id));
        return row?.lastReceivedAt;
      };

      await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });
      expect(await lastReceived()).toEqual(T0);
      clock = new Date(T0.getTime() + 30 * 1000);
      await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });
      expect(await lastReceived()).toEqual(T0);
      clock = new Date(T0.getTime() + 61 * 1000);
      await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });
      expect(await lastReceived()).toEqual(clock);
    });

    it('never fails a recorded delivery when the update fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { ingestKey, secret, box } = await setup(InboundKinds.sentry);
      class BrokenTouchRepo extends InboundSourceRepo {
        // eslint-disable-next-line class-methods-use-this -- always fails, whatever the db; proves the failure is non-fatal
        override async touchLastReceived(): Promise<void> {
          return await Promise.reject(new Error('db is down'));
        }
      }
      const inbound = new InboundService({
        sources: new BrokenTouchRepo(t.db),
        receipts: new InboundReceiptRepo(t.db),
        box,
        bus: createTestEventBus(t.db, now),
        now,
      });

      expect(await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) })).toEqual({
        status: IngestStatuses.accepted,
        outcome: IngestOutcomes.published,
      });
    });
  });

  describe('log hygiene', () => {
    it('logs only the source id and error class when the secret does not open', async () => {
      const logged: unknown[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      const { inbound, ingestKey, secret, source } = await setup(InboundKinds.sentry);
      // Another row's sealed value: its AAD does not match this row, so it fails to open.
      const other = await setup(InboundKinds.sentry);
      const [otherRow] = await t.db.select().from(inboundSources).where(eq(inboundSources.id, other.source.id));
      await t.db
        .update(inboundSources)
        .set({ secretSealed: otherRow?.secretSealed ?? '' })
        .where(eq(inboundSources.id, source.id));

      await expect(inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) })).rejects.toThrow();

      expect(logged).toEqual([
        ['[inbound] opening the source secret failed', { sourceId: source.id, error: 'SecretBoxError' }],
      ]);
    });

    it('logs a failed publish as receipt id, source id and error class, never the message', async () => {
      const logged: unknown[] = [];
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      const leaky: EventPublisher = {
        publish: async () => await Promise.reject(new Error('insert … params: [sealed, key, payload]')),
      };
      const { inbound, ingestKey, secret, source } = await setup(InboundKinds.sentry, { bus: leaky });

      await inbound.ingest({ ingestKey, ...signedDelivery(InboundKinds.sentry, secret) });

      const [receipt] = await t.db.select().from(inboundReceipts);
      expect(logged).toEqual([
        ['[inbound] publishing a receipt failed', { receiptId: receipt?.id, sourceId: source.id, error: 'Error' }],
      ]);
    });
  });

  describe('prune', () => {
    it('deletes receipts older than 30 days in batches and keeps newer ones', async () => {
      const { inbound, source, workspaceId } = await setup(InboundKinds.sentry);
      const old = new Date(T0.getTime() - 31 * 24 * 60 * 60 * 1000);
      await t.db.insert(inboundReceipts).values([
        ...Array.from({ length: 5 }, (_, index) => ({
          workspaceId,
          sourceId: source.id,
          externalId: `old-${index}`,
          outcome: InboundOutcomes.ignored,
          receivedAt: old,
        })),
        { workspaceId, sourceId: source.id, externalId: 'new', outcome: InboundOutcomes.ignored, receivedAt: T0 },
      ]);

      expect(await inbound.pruneReceipts({ batchSize: 2 })).toBe(5);

      const left = await t.db.select().from(inboundReceipts);
      expect(left.map(receipt => receipt.externalId)).toEqual(['new']);
    });
  });

  it('never puts a secret in a receipt, an event, a job or a log line', async () => {
    const logs: unknown[] = [];
    const record = (...args: unknown[]) => {
      logs.push(args);
    };
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation(record);
    vi.spyOn(console, 'log').mockImplementation(record);
    // One source at a time keeps the single pglite connection serial.
    const secrets = await KINDS.reduce<Promise<string[]>>(async (previous, kind) => {
      const done = await previous;
      const { inbound, ingestKey, secret } = await setup(kind);
      await inbound.ingest({ ingestKey, ...signedDelivery(kind, secret) });
      await inbound.ingest({ ingestKey, ...signedDelivery(kind, 'x', { signWith: 'wrong' }) });
      return [...done, secret];
    }, Promise.resolve([]));

    const stored = JSON.stringify(
      {
        receipts: await t.db.select().from(inboundReceipts),
        events: await t.db.select().from(domainEvents),
        jobs: await t.db.select().from(jobs),
        logs,
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    expect(secrets).toHaveLength(KINDS.length);
    expect(secrets.filter(secret => stored.includes(secret))).toEqual([]);
  });
});
