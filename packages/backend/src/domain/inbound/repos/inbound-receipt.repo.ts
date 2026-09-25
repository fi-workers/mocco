import { InboundOutcomes } from '@mocco/common/inbound';
import { and, asc, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { InboundOutcome } from '@mocco/common/inbound';

const { inboundReceipts } = schema;

export type InboundReceiptRow = typeof inboundReceipts.$inferSelect;
export type NewInboundReceipt = Pick<
  typeof inboundReceipts.$inferInsert,
  | 'workspaceId'
  | 'sourceId'
  | 'externalId'
  | 'sourceEvent'
  | 'outcome'
  | 'reason'
  | 'eventType'
  | 'normalized'
  | 'receivedAt'
>;

export interface ReceiptListFilter {
  sourceId?: string;
  outcome?: InboundOutcome;
  /** Only receipts with a lower `seq` (the previous page's last one). */
  beforeSeq?: bigint;
  limit: number;
}

/** Both drivers (node-postgres, pglite) return `{ rows }` from a raw query. */
const pruneCountSchema = z.object({ rows: z.array(z.object({ count: z.coerce.number() })) });

const isPending = eq(inboundReceipts.outcome, InboundOutcomes.pending);

/** Data access for mocco_inbound_receipts (ADR 0012). Trace reads are scoped by
 * `workspace_id`; the jobs (republish, prune) are platform-scoped, like the job runner. */
export class InboundReceiptRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert a receipt, in one statement, unless the source already recorded that
   * delivery id: then nothing is written and undefined is returned (a redelivery).
   */
  async insertIfNew(values: NewInboundReceipt): Promise<InboundReceiptRow | undefined> {
    const [row] = await this.db
      .insert(inboundReceipts)
      .values(values)
      .onConflictDoNothing({ target: [inboundReceipts.sourceId, inboundReceipts.externalId] })
      .returning();
    return row;
  }

  /** Receipts of any outcome of the workspace received at or after `since` (the hard ceiling). */
  async countSince(workspaceId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(inboundReceipts)
      .where(and(eq(inboundReceipts.workspaceId, workspaceId), gte(inboundReceipts.receivedAt, since)));
    return row?.value ?? 0;
  }

  /** Published receipts of the workspace received at or after `since` (the quota). */
  async countPublishedSince(workspaceId: string, since: Date): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(inboundReceipts)
      .where(
        and(
          eq(inboundReceipts.workspaceId, workspaceId),
          eq(inboundReceipts.outcome, InboundOutcomes.published),
          gte(inboundReceipts.receivedAt, since),
        ),
      );
    return row?.value ?? 0;
  }

  /** Mark a pending receipt published with its event. False when it was no longer
   * pending (another run finished it first). */
  async markPublished(receiptId: string, domainEventId: string): Promise<boolean> {
    const rows = await this.db
      .update(inboundReceipts)
      .set({ outcome: InboundOutcomes.published, domainEventId })
      .where(and(eq(inboundReceipts.id, receiptId), isPending))
      .returning({ id: inboundReceipts.id });
    return rows.length > 0;
  }

  /** Move a pending receipt to a final outcome without an event (`over_quota`, or
   * `ignored` for a stored payload that no longer parses). */
  async markDropped(
    receiptId: string,
    outcome: typeof InboundOutcomes.over_quota | typeof InboundOutcomes.ignored,
    reason: string,
  ): Promise<boolean> {
    const rows = await this.db
      .update(inboundReceipts)
      .set({ outcome, reason })
      .where(and(eq(inboundReceipts.id, receiptId), isPending))
      .returning({ id: inboundReceipts.id });
    return rows.length > 0;
  }

  /** Pending receipts received before `before`: fewest failed publishes first, then
   * oldest, so receipts that keep failing never starve newer ones. */
  async listPendingBefore(before: Date, limit: number): Promise<InboundReceiptRow[]> {
    return await this.db
      .select()
      .from(inboundReceipts)
      .where(and(isPending, lt(inboundReceipts.receivedAt, before)))
      .orderBy(asc(inboundReceipts.publishAttempts), asc(inboundReceipts.receivedAt))
      .limit(limit);
  }

  /** Count one failed publish of a pending receipt; returns the new count (0 when the
   * receipt is no longer pending). */
  async recordPublishFailure(receiptId: string): Promise<number> {
    const [row] = await this.db
      .update(inboundReceipts)
      .set({ publishAttempts: sql`${inboundReceipts.publishAttempts} + 1` })
      .where(and(eq(inboundReceipts.id, receiptId), isPending))
      .returning({ publishAttempts: inboundReceipts.publishAttempts });
    return row?.publishAttempts ?? 0;
  }

  /** A page of the workspace's receipts, newest first. */
  async listByWorkspace(workspaceId: string, filter: ReceiptListFilter): Promise<InboundReceiptRow[]> {
    const conditions: SQL[] = [eq(inboundReceipts.workspaceId, workspaceId)];
    if (filter.sourceId !== undefined) {
      conditions.push(eq(inboundReceipts.sourceId, filter.sourceId));
    }
    if (filter.outcome !== undefined) {
      conditions.push(eq(inboundReceipts.outcome, filter.outcome));
    }
    if (filter.beforeSeq !== undefined) {
      conditions.push(lt(inboundReceipts.seq, filter.beforeSeq));
    }
    return await this.db
      .select()
      .from(inboundReceipts)
      .where(and(...conditions))
      .orderBy(desc(inboundReceipts.seq))
      .limit(filter.limit);
  }

  /** Delete at most `limit` receipts received before `before`. Returns how many were
   * deleted; fewer than `limit` means none are left. */
  async pruneBefore(before: Date, limit: number): Promise<number> {
    const result = await this.db.execute(sql`
      WITH deleted AS (
        DELETE FROM ${inboundReceipts}
        WHERE ${inboundReceipts.id} IN (
          SELECT ${inboundReceipts.id} FROM ${inboundReceipts}
          WHERE ${inboundReceipts.receivedAt} < ${before}
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
