import { eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** Data access for mocco_mcp_settings. One row per workspace, keyed by `workspace_id`. */
export class McpSettingsRepo {
  constructor(private readonly db: Db) {}

  /** The workspace's stored settings, if it has ever changed them. */
  async find(workspaceId: string) {
    const [row] = await this.db
      .select()
      .from(schema.mcpSettings)
      .where(eq(schema.mcpSettings.workspaceId, workspaceId));
    return row;
  }

  /** Set whether agents may decide, creating the row on first change. */
  async setAgentsMayDecide(workspaceId: string, canAgentsDecide: boolean, changedByUserId: string) {
    const changedAt = new Date();
    return expectOne(
      await this.db
        .insert(schema.mcpSettings)
        .values({ workspaceId, agentsMayDecide: canAgentsDecide, changedAt, changedByUserId })
        .onConflictDoUpdate({
          target: schema.mcpSettings.workspaceId,
          set: { agentsMayDecide: canAgentsDecide, changedAt, changedByUserId },
        })
        .returning(),
    );
  }
}
