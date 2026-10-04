// Production composition root for the MCP domain's settings. Lazy so builds don't need
// env at import. No external dependency — always available.
import { getAudit } from '@backend/domain/audit/instance';
import { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import { McpSettingsRepo } from '@backend/domain/mcp/repos/mcp-settings.repo';
import { getDb } from '@backend/infra/db/client';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { Db } from '@backend/infra/db/types';

/** Build the settings service over a db. The production root below binds it once; tests
 * call it with a pglite db — same classes, same wiring. */
export function createMcpSettingsService(db: Db, audit: AuditService): McpSettingsService {
  return new McpSettingsService({ settings: new McpSettingsRepo(db), audit });
}

const state: { settings?: McpSettingsService } = {};

/** The MCP settings service. Always available (no external dependency to gate on). */
export function getMcpSettings(): McpSettingsService {
  state.settings ??= createMcpSettingsService(getDb(), getAudit().audit);
  return state.settings;
}
