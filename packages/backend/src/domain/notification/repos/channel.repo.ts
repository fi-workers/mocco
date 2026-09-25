import { ChannelStatuses } from '@mocco/common/notification';
import { and, asc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

const { notificationChannels } = schema;

export type ChannelRow = typeof notificationChannels.$inferSelect;
export type NewChannel = Pick<
  typeof notificationChannels.$inferInsert,
  'workspaceId' | 'kind' | 'name' | 'config' | 'externalId'
>;

/** Data access for mocco_notification_channels (ADR 0012). Every query is workspace-scoped. */
export class ChannelRepo {
  constructor(private readonly db: Db) {}

  async insert(values: NewChannel): Promise<ChannelRow> {
    return expectOne(await this.db.insert(notificationChannels).values(values).returning());
  }

  async findById(workspaceId: string, id: string): Promise<ChannelRow | undefined> {
    const [row] = await this.db
      .select()
      .from(notificationChannels)
      .where(and(eq(notificationChannels.workspaceId, workspaceId), eq(notificationChannels.id, id)));
    return row;
  }

  /** Active channels of a workspace — the fan-out's candidates. */
  async findActiveByWorkspace(workspaceId: string): Promise<ChannelRow[]> {
    return await this.db
      .select()
      .from(notificationChannels)
      .where(
        and(eq(notificationChannels.workspaceId, workspaceId), eq(notificationChannels.status, ChannelStatuses.active)),
      )
      .orderBy(asc(notificationChannels.createdAt), asc(notificationChannels.id));
  }

  /** Stop delivering to a channel, keeping why. Returns the updated row (undefined if gone). */
  async disable(workspaceId: string, id: string, reason: string): Promise<ChannelRow | undefined> {
    const [row] = await this.db
      .update(notificationChannels)
      .set({ status: ChannelStatuses.disabled, disabledReason: reason })
      .where(and(eq(notificationChannels.workspaceId, workspaceId), eq(notificationChannels.id, id)))
      .returning();
    return row;
  }
}
