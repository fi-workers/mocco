import { desc, eq, lt, sql } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const { opsCanaries, domainEvents } = schema;

export type OpsCanaryRow = typeof opsCanaries.$inferSelect;
export type NewOpsCanary = Pick<
  typeof opsCanaries.$inferInsert,
  'canaryId' | 'sourceId' | 'sentAt' | 'ingestStatus' | 'error'
>;

/** Data access for mocco_ops_canaries (ADR 0012). Platform-scoped: the canary belongs
 * to the deployment, not to a workspace. */
export class OpsCanaryRepo {
  constructor(private readonly db: Db) {}

  /** Record a canary attempt. A retry of the same canary id (the same minute)
   * overwrites the earlier attempt. */
  async record(values: NewOpsCanary): Promise<OpsCanaryRow> {
    return expectOne(
      await this.db
        .insert(opsCanaries)
        .values(values)
        .onConflictDoUpdate({
          target: opsCanaries.canaryId,
          set: { sentAt: values.sentAt, ingestStatus: values.ingestStatus, error: values.error },
        })
        .returning(),
    );
  }

  /**
   * Mark the canary whose domain event is `eventId` delivered. The canary id is the
   * event's `branch` fact (the canary's `workflow_run.head_branch`). Returns the row, or
   * undefined when no canary record matches (it was pruned, or sent by hand).
   */
  async markDeliveredByEvent(eventId: string, deliveredAt: Date): Promise<OpsCanaryRow | undefined> {
    const canaryId = sql`(SELECT ${domainEvents.payload} #>> '{facts,branch}' FROM ${domainEvents} WHERE ${domainEvents.id} = ${eventId})`;
    const [row] = await this.db
      .update(opsCanaries)
      .set({ deliveredAt })
      .where(eq(opsCanaries.canaryId, canaryId))
      .returning();
    return row;
  }

  /** Record the heartbeat ping of a delivered canary; `status` null when it never answered. */
  async recordHeartbeat(id: string, heartbeatAt: Date, status: number | null): Promise<void> {
    await this.db.update(opsCanaries).set({ heartbeatAt, heartbeatStatus: status }).where(eq(opsCanaries.id, id));
  }

  /** The most recent canaries, newest first. */
  async findRecent(limit: number): Promise<OpsCanaryRow[]> {
    return await this.db.select().from(opsCanaries).orderBy(desc(opsCanaries.sentAt)).limit(limit);
  }

  /** Delete canaries sent before `before`; returns how many. */
  async pruneBefore(before: Date): Promise<number> {
    const deleted = await this.db
      .delete(opsCanaries)
      .where(lt(opsCanaries.sentAt, before))
      .returning({ id: opsCanaries.id });
    return deleted.length;
  }
}
