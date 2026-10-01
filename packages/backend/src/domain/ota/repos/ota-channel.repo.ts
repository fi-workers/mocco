import { and, asc, eq } from 'drizzle-orm';

import { rethrowUniqueViolation } from '@backend/infra/db/errors';
import { expectOne, getOrThrow } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { GateRequirements } from '@mocco/common/governance';

export type OtaChannelRow = typeof schema.otaChannels.$inferSelect;

/** Data access for mocco_ota_channels. */
export class OtaChannelRepo {
  constructor(private readonly db: Db) {}

  /** Insert a channel. Throws UniqueConstraintError when the app already has the name. */
  async insert(row: typeof schema.otaChannels.$inferInsert) {
    try {
      return expectOne(await this.db.insert(schema.otaChannels).values(row).returning());
    } catch (error) {
      return rethrowUniqueViolation(error);
    }
  }

  async listByApp(workspaceId: string, appId: string) {
    return await this.db
      .select()
      .from(schema.otaChannels)
      .where(and(eq(schema.otaChannels.workspaceId, workspaceId), eq(schema.otaChannels.appId, appId)))
      .orderBy(asc(schema.otaChannels.createdAt));
  }

  async getInApp(workspaceId: string, appId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.otaChannels)
      .where(
        and(
          eq(schema.otaChannels.id, id),
          eq(schema.otaChannels.workspaceId, workspaceId),
          eq(schema.otaChannels.appId, appId),
        ),
      );
    return getOrThrow(rows, `OTA channel ${id} was not found`);
  }

  /** A channel by id within its workspace (for the approval handler). */
  /** An app's channel by name, or undefined. */
  async findByName(appId: string, name: string) {
    const [row] = await this.db
      .select()
      .from(schema.otaChannels)
      .where(and(eq(schema.otaChannels.appId, appId), eq(schema.otaChannels.name, name)));
    return row;
  }

  async getInWorkspace(workspaceId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.otaChannels)
      .where(and(eq(schema.otaChannels.id, id), eq(schema.otaChannels.workspaceId, workspaceId)));
    return getOrThrow(rows, `OTA channel ${id} was not found`);
  }

  /** Set the protection policy if the channel hasn't changed since `expectedUpdatedAt`.
   * Undefined when it has (a newer edit won). */
  async setPolicyIfUnchanged(id: string, policy: GateRequirements | null, expectedUpdatedAt: Date, now: Date) {
    const [row] = await this.db
      .update(schema.otaChannels)
      .set({ isProtected: policy !== null, policy, updatedAt: now })
      .where(and(eq(schema.otaChannels.id, id), eq(schema.otaChannels.updatedAt, expectedUpdatedAt)))
      .returning();
    return row;
  }
}
