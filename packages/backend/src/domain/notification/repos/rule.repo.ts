import { and, asc, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const { notificationRules } = schema;

export type RuleRow = typeof notificationRules.$inferSelect;
export type NewRule = Pick<
  typeof notificationRules.$inferInsert,
  'workspaceId' | 'channelId' | 'eventType' | 'sourceId' | 'filter'
>;

/** Data access for mocco_notification_rules (ADR 0012). Every query is workspace-scoped. */
export class RuleRepo {
  constructor(private readonly db: Db) {}

  /** Insert rules; a rule the channel already has (same type, source and filter) is skipped. */
  async insertMany(values: NewRule[]): Promise<RuleRow[]> {
    if (values.length === 0) {
      return [];
    }
    return await this.db.insert(notificationRules).values(values).onConflictDoNothing().returning();
  }

  /** A channel's rules, oldest first. */
  async findByChannel(workspaceId: string, channelId: string): Promise<RuleRow[]> {
    return await this.db
      .select()
      .from(notificationRules)
      .where(and(eq(notificationRules.workspaceId, workspaceId), eq(notificationRules.channelId, channelId)))
      .orderBy(asc(notificationRules.createdAt), asc(notificationRules.id));
  }

  /** Delete a rule. Returns false when absent. */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(notificationRules)
      .where(and(eq(notificationRules.workspaceId, workspaceId), eq(notificationRules.id, id)))
      .returning({ id: notificationRules.id });
    return deleted.length > 0;
  }

  /** Every rule of a workspace, oldest first — the fan-out groups them by channel. */
  async findByWorkspace(workspaceId: string): Promise<RuleRow[]> {
    return await this.db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.workspaceId, workspaceId))
      .orderBy(asc(notificationRules.createdAt), asc(notificationRules.id));
  }
}
