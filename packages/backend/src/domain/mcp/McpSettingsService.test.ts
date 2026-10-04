import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';

describe('McpSettingsService (pglite)', () => {
  let t: TestDb;
  let audit: AuditService;
  let service: McpSettingsService;
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    service = createMcpSettingsService(t.db, audit);
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com`, name: 'Ada' })
        .returning(),
    ).id;
  });
  afterEach(async () => {
    await t.close();
  });

  const auditedActions = async () => {
    const entries = await audit.list(workspaceId, 0n);
    return entries.map(entry => entry.action);
  };

  it('keeps agents from deciding until someone turns it on', async () => {
    expect(await service.get(workspaceId)).toEqual({ agentsMayDecide: false, changedAt: null, changedByUserId: null });
    expect(await service.agentsMayDecide(workspaceId)).toBe(false);
  });

  it('records who switched it, in the setting and in the audit chain', async () => {
    const on = await service.setAgentsMayDecide(workspaceId, true, userId);

    expect(on).toMatchObject({ agentsMayDecide: true, changedByUserId: userId });
    expect(on.changedAt).toBeInstanceOf(Date);
    expect(await service.agentsMayDecide(workspaceId)).toBe(true);

    await service.setAgentsMayDecide(workspaceId, false, userId);
    expect(await service.agentsMayDecide(workspaceId)).toBe(false);
    expect(await auditedActions()).toEqual([
      AuditActions.mcpAgentsMayDecideChanged,
      AuditActions.mcpAgentsMayDecideChanged,
    ]);
  });

  it('audits nothing when the value does not change', async () => {
    await service.setAgentsMayDecide(workspaceId, false, userId);
    await service.setAgentsMayDecide(workspaceId, true, userId);
    await service.setAgentsMayDecide(workspaceId, true, userId);

    expect(await auditedActions()).toEqual([AuditActions.mcpAgentsMayDecideChanged]);
  });
});
