import { DeliveryStatuses } from '@mocco/common/notification';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { DeliveryStatus } from '@mocco/common/notification';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

export type SubscriberDeliveryRow = typeof schema.statusSubscriberDeliveries.$inferSelect;
export type NewSubscriberDelivery = Pick<
  typeof schema.statusSubscriberDeliveries.$inferInsert,
  'workspaceId' | 'subscriberId' | 'kind' | 'dedupeKey' | 'content'
>;
export type SubscriberDeliveryUpdate = Pick<
  PgUpdateSetSource<typeof schema.statusSubscriberDeliveries>,
  'status' | 'error' | 'sendingAt' | 'sentAt'
>;

const d = schema.statusSubscriberDeliveries;

const SETTLED: readonly DeliveryStatus[] = [
  DeliveryStatuses.sent,
  DeliveryStatuses.failed,
  DeliveryStatuses.suppressed,
];

/** Data access for mocco_status_subscriber_deliveries. By id: the delivery job has no caller scope. */
export class SubscriberDeliveryRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert queued deliveries, skipping every (subscriber, dedupe key) pair that already has one,
   * and return the ones inserted. Run it in the transaction that enqueues their jobs.
   */
  async insertNew(rows: readonly NewSubscriberDelivery[]): Promise<SubscriberDeliveryRow[]> {
    if (rows.length === 0) {
      return [];
    }
    return await this.db
      .insert(d)
      .values([...rows])
      .onConflictDoNothing({ target: [d.subscriberId, d.dedupeKey] })
      .returning();
  }

  async findById(id: string): Promise<SubscriberDeliveryRow | undefined> {
    const [row] = await this.db.select().from(d).where(eq(d.id, id));
    return row;
  }

  /** Claim a queued delivery for sending, counting the attempt. Of two runs only one gets it. */
  async claim(id: string, now: Date): Promise<SubscriberDeliveryRow | undefined> {
    const [row] = await this.db
      .update(d)
      .set({ status: DeliveryStatuses.sending, sendingAt: now, attempts: sql`${d.attempts} + 1` })
      .where(and(eq(d.id, id), eq(d.status, DeliveryStatuses.queued)))
      .returning();
    return row;
  }

  /** Update a delivery only while its status is `from`, so a settled one is never changed. */
  async updateFrom(id: string, from: DeliveryStatus, values: SubscriberDeliveryUpdate): Promise<boolean> {
    const updated = await this.db
      .update(d)
      .set(values)
      .where(and(eq(d.id, id), eq(d.status, from)))
      .returning({ id: d.id });
    return updated.length > 0;
  }

  /** Delete settled deliveries created before `before`. */
  async pruneSettled(before: Date): Promise<number> {
    const deleted = await this.db
      .delete(d)
      .where(and(lt(d.createdAt, before), inArray(d.status, [...SETTLED])))
      .returning({ id: d.id });
    return deleted.length;
  }
}
