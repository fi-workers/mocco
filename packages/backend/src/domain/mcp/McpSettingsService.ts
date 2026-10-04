// What a workspace decides about agents on the MCP surface.
//
// Today that is one switch: whether the deciding tools — voting on an approval, resuming
// a gate — are available at all. It is off by default because those tools can release a
// production deploy, and a workspace whose agents only report should never have to think
// about them. Switching it on widens nothing by itself: every tool still acts as its
// caller, and the caller's roles are still the only authority.
//
// Who may switch it is the transport's check (owners and admins), as it is for API keys.
import { AuditActions } from '@mocco/common/audit';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { McpSettingsRepo } from '@backend/domain/mcp/repos/mcp-settings.repo';
import type { McpSettings } from '@mocco/common/mcp';

export interface McpSettingsServiceDeps {
  settings: McpSettingsRepo;
  audit: Pick<AuditService, 'record'>;
}

export class McpSettingsService {
  constructor(private readonly deps: McpSettingsServiceDeps) {}

  /** The workspace's settings; a workspace that never changed them gets the defaults. */
  async get(workspaceId: string): Promise<McpSettings> {
    const row = await this.deps.settings.find(workspaceId);
    return {
      agentsMayDecide: row?.agentsMayDecide ?? false,
      changedAt: row?.changedAt ?? null,
      changedByUserId: row?.changedByUserId ?? null,
    };
  }

  /** Whether agents may use the deciding tools in this workspace. */
  async agentsMayDecide(workspaceId: string): Promise<boolean> {
    const { agentsMayDecide } = await this.get(workspaceId);
    return agentsMayDecide;
  }

  /**
   * Turn the deciding tools on or off, recording who did. A repeat of the current value is
   * a no-op — nothing changed, so there is nothing to audit.
   */
  async setAgentsMayDecide(workspaceId: string, canAgentsDecide: boolean, actorUserId: string): Promise<McpSettings> {
    const current = await this.get(workspaceId);
    if (current.agentsMayDecide === canAgentsDecide) {
      return current;
    }
    const row = await this.deps.settings.setAgentsMayDecide(workspaceId, canAgentsDecide, actorUserId);
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.mcpAgentsMayDecideChanged,
      subjectType: 'workspace',
      subjectId: workspaceId,
      payload: { agentsMayDecide: canAgentsDecide },
    });
    return {
      agentsMayDecide: row.agentsMayDecide,
      changedAt: row.changedAt,
      changedByUserId: row.changedByUserId,
    };
  }
}
