import { asc, eq } from 'drizzle-orm';

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

  /** Every rule of a workspace, oldest first — the fan-out groups them by channel. */
  async findByWorkspace(workspaceId: string): Promise<RuleRow[]> {
    return await this.db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.workspaceId, workspaceId))
      .orderBy(asc(notificationRules.createdAt), asc(notificationRules.id));
  }
}
