import { DeliveryStatuses } from '@mocco/common/notification';
import { and, count, desc, eq, gte, min, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { DeliveryStatus } from '@mocco/common/notification';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

const { notificationDeliveries } = schema;

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type NewDelivery = Pick<
  typeof notificationDeliveries.$inferInsert,
  'workspaceId' | 'channelId' | 'eventId' | 'ruleId' | 'message'
>;
/** The columns a delivery job settles or annotates. */
export type DeliveryUpdate = Pick<
  PgUpdateSetSource<typeof notificationDeliveries>,
  'status' | 'responseCode' | 'error' | 'externalMessageId' | 'nextAttemptAt' | 'sentAt'
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
   * Update a delivery that is still `queued`. A settled delivery (sent, failed,
   * suppressed) is never overwritten, so a second run of its job cannot undo the first.
   * Returns false when nothing was updated.
   */
  async updateQueued(id: string, values: DeliveryUpdate): Promise<boolean> {
    const updated = await this.db
      .update(notificationDeliveries)
      .set(values)
      .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.status, DeliveryStatuses.queued)))
      .returning({ id: notificationDeliveries.id });
    return updated.length > 0;
  }

  /** Count a send attempt on a queued delivery (just before calling the sender). */
  async recordAttempt(id: string): Promise<void> {
    await this.db
      .update(notificationDeliveries)
      .set({ attempts: sql`${notificationDeliveries.attempts} + 1` })
      .where(and(eq(notificationDeliveries.id, id), eq(notificationDeliveries.status, DeliveryStatuses.queued)));
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
