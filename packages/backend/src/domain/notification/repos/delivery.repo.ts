import { JobStatuses } from '@mocco/common/jobs';
import { DeliveryStatuses } from '@mocco/common/notification';
import { and, count, desc, eq, gte, inArray, lt, min, notExists, or, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { DeliveryStatus } from '@mocco/common/notification';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

const { notificationDeliveries, jobs } = schema;

/** A delivery a run may still act on (not settled). */
const UNSETTLED: readonly DeliveryStatus[] = [DeliveryStatuses.queued, DeliveryStatuses.sending];

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type NewDelivery = Pick<
  typeof notificationDeliveries.$inferInsert,
  'workspaceId' | 'channelId' | 'eventId' | 'ruleId' | 'message' | 'canary'
>;
/** The columns a delivery job settles or annotates. */
export type DeliveryUpdate = Pick<
  PgUpdateSetSource<typeof notificationDeliveries>,
  'status' | 'responseCode' | 'error' | 'externalMessageId' | 'nextAttemptAt' | 'sentAt' | 'sendingAt'
>;

/** Data access for mocco_notification_deliveries (ADR 0012). Reads by id are
 * platform-scoped (the job runner drains every workspace); the row carries its workspace. */
export class DeliveryRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert a queued delivery unless the (event, channel) pair already has one, and run
   * `onCreated` in the same transaction (the caller enqueues its job there, passing the
   * transaction as the queue's `executor`). Returns undefined for an existing pair —
   * a redelivered event — without calling `onCreated`.
   */
  async createQueued<T>(
    values: NewDelivery,
    onCreated: (delivery: DeliveryRow, executor: Db) => Promise<T>,
  ): Promise<{ delivery: DeliveryRow; created: T } | undefined> {
    return await this.db.transaction(async tx => {
      const [delivery] = await tx
        .insert(notificationDeliveries)
        .values(values)
        .onConflictDoNothing({ target: [notificationDeliveries.eventId, notificationDeliveries.channelId] })
        .returning();
      if (delivery === undefined) {
        return undefined;
      }
      return { delivery, created: await onCreated(delivery, tx) };
    });
  }

  /** A workspace's most recent deliveries, optionally of one channel and/or status. */
  async findRecent(
    workspaceId: string,
    options: { channelId?: string; status?: DeliveryStatus; limit: number },
  ): Promise<DeliveryRow[]> {
    return await this.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.workspaceId, workspaceId),
          options.channelId === undefined ? undefined : eq(notificationDeliveries.channelId, options.channelId),
          options.status === undefined ? undefined : eq(notificationDeliveries.status, options.status),
        ),
      )
      .orderBy(desc(notificationDeliveries.createdAt), desc(notificationDeliveries.id))
      .limit(options.limit);
  }

  async findById(id: string): Promise<DeliveryRow | undefined> {
    const [row] = await this.db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id));
    return row;
  }

  /**
   * Update a delivery only while its status is `from`. A settled delivery (sent,
   * failed, suppressed) is never passed as `from`, so a second run of its job cannot
   * undo the first. Returns false when nothing was updated.
   */
  async updateFrom(id: string, from: DeliveryStatus, values: DeliveryUpdate): Promise<boolean> {
    const updated = await this.db
      .update(notificationDeliveries)
      .set(values)
      .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.status, from)))
      .returning({ id: notificationDeliveries.id });
    return updated.length > 0;
  }

  /**
   * Claim a delivery for sending: `queued` (or a `sending` claim older than
   * `staleBefore`, left by a run that died) → `sending`, counting the attempt. One
   * conditional UPDATE, so of two overlapping runs only one gets the row. Returns the
   * claimed row, or undefined when another run holds it or it is settled.
   */
  async claimForSending(id: string, now: Date, staleBefore: Date): Promise<DeliveryRow | undefined> {
    const [row] = await this.db
      .update(notificationDeliveries)
      .set({
        status: DeliveryStatuses.sending,
        sendingAt: now,
        attempts: sql`${notificationDeliveries.attempts} + 1`,
      })
      .where(
        and(
          eq(notificationDeliveries.id, id),
          or(
            eq(notificationDeliveries.status, DeliveryStatuses.queued),
            and(
              eq(notificationDeliveries.status, DeliveryStatuses.sending),
              lt(notificationDeliveries.sendingAt, staleBefore),
            ),
          ),
        ),
      )
      .returning();
    return row;
  }

  /**
   * Unsettled deliveries (queued or sending) whose `jobKind` job is no longer live
   * (queued or running) — its job died, so nothing will ever settle them. The job's
   * dedupe key is the delivery id. Platform-scoped: the reconcile covers every workspace.
   */
  async findOrphaned(jobKind: string, limit: number): Promise<DeliveryRow[]> {
    const liveJob = this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, jobKind),
          eq(jobs.dedupeKey, sql`${notificationDeliveries.id}::text`),
          inArray(jobs.status, [JobStatuses.queued, JobStatuses.running]),
        ),
      );
    return await this.db
      .select()
      .from(notificationDeliveries)
      .where(and(inArray(notificationDeliveries.status, [...UNSETTLED]), notExists(liveJob)))
      .orderBy(notificationDeliveries.createdAt)
      .limit(limit);
  }

  /** Fail unsettled deliveries by id with `error`. Returns how many were failed. */
  async failUnsettled(ids: readonly string[], error: string): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const failed = await this.db
      .update(notificationDeliveries)
      .set({ status: DeliveryStatuses.failed, error, nextAttemptAt: null })
      .where(and(inArray(notificationDeliveries.id, [...ids]), inArray(notificationDeliveries.status, [...UNSETTLED])))
      .returning({ id: notificationDeliveries.id });
    return failed.length;
  }

  /** How many deliveries of the workspace were sent at or after `since`, and the
   * earliest of those sends (per-workspace fairness). */
  async sentSince(workspaceId: string, since: Date): Promise<{ sent: number; oldest: Date | null }> {
    const [row] = await this.db
      .select({ sent: count(), oldest: min(notificationDeliveries.sentAt) })
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.workspaceId, workspaceId), gte(notificationDeliveries.sentAt, since)));
    return { sent: row?.sent ?? 0, oldest: row?.oldest ?? null };
  }
}
