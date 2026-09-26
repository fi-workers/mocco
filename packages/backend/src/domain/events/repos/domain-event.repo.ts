import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const { domainEvents, domainEventDeliveries } = schema;

export type DomainEventRow = typeof domainEvents.$inferSelect;
export type NewDomainEvent = Pick<
  typeof domainEvents.$inferInsert,
  'workspaceId' | 'projectId' | 'type' | 'subjectType' | 'subjectId' | 'payload' | 'dedupeKey' | 'occurredAt'
>;

/** Both drivers (node-postgres, pglite) return `{ rows }` from a raw query. */
const pruneCountSchema = z.object({ rows: z.array(z.object({ count: z.coerce.number() })) });

/** The predicate of `mocco_domain_events_workspace_dedupe_key_uq`, repeated as the ON CONFLICT arbiter. */
const hasDedupeKey = sql.raw('dedupe_key IS NOT NULL');

/** Data access for mocco_domain_events and its delivery ledger (ADR 0012, ADR 0018).
 * Delivery reads by id are platform-scoped (the job runner drains every workspace);
 * the event row carries its workspace for the subscriber. */
export class DomainEventRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert an event. With a `dedupeKey`, an existing event of the same workspace and
   * key wins: nothing is inserted and that event is returned with `created: false`.
   */
  async insert(values: NewDomainEvent): Promise<{ event: DomainEventRow; created: boolean }> {
    if (values.dedupeKey == null) {
      return { event: expectOne(await this.db.insert(domainEvents).values(values).returning()), created: true };
    }
    const [inserted] = await this.db
      .insert(domainEvents)
      .values(values)
      .onConflictDoNothing({ target: [domainEvents.workspaceId, domainEvents.dedupeKey], where: hasDedupeKey })
      .returning();
    if (inserted) {
      return { event: inserted, created: true };
    }
    const existing = await this.db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.workspaceId, values.workspaceId), eq(domainEvents.dedupeKey, values.dedupeKey)));
    return { event: expectOne(existing), created: false };
  }

  /** An event by id, or undefined once pruned (a late delivery then has nothing to do). */
  async findById(id: string): Promise<DomainEventRow | undefined> {
    const [row] = await this.db.select().from(domainEvents).where(eq(domainEvents.id, id));
    return row;
  }

  /** Has `subscriber` already handled the event? */
  async isDelivered(eventId: string, subscriber: string): Promise<boolean> {
    const rows = await this.db
      .select({ eventId: domainEventDeliveries.eventId })
      .from(domainEventDeliveries)
      .where(and(eq(domainEventDeliveries.eventId, eventId), eq(domainEventDeliveries.subscriber, subscriber)));
    return rows.length > 0;
  }

  /** Record that `subscriber` handled the event (idempotent). */
  async markDelivered(eventId: string, subscriber: string, deliveredAt: Date): Promise<void> {
    await this.db.insert(domainEventDeliveries).values({ eventId, subscriber, deliveredAt }).onConflictDoNothing();
  }

  /** Delete at most `limit` events that occurred before `before` (their deliveries
   * cascade). Returns how many were deleted; fewer than `limit` means none are left. */
  async pruneBefore(before: Date, limit: number): Promise<number> {
    const result = await this.db.execute(sql`
      WITH deleted AS (
        DELETE FROM ${domainEvents}
        WHERE ${domainEvents.id} IN (
          SELECT ${domainEvents.id} FROM ${domainEvents}
          WHERE ${domainEvents.occurredAt} < ${before}
          LIMIT ${limit}
        )
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM deleted
    `);
    const [row] = pruneCountSchema.parse(result).rows;
    return row?.count ?? 0;
  }
}
