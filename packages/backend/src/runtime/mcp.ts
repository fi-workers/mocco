// Composition root for the MCP server — above the domains, like the job runner.
//
// It builds the per-request server from the domain services. `createMcpHandler` asks for
// one instance per request because the 2026-07-28 protocol is stateless: there is no
// session to keep, and any request may land on any deployment — which is also why the
// confirmation state is signed with a key every deployment derives from the same secret.
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { getExecution } from '@backend/domain/execution/instance';
import { getGovernance } from '@backend/domain/governance/instance';
import { getMcpSettings } from '@backend/domain/mcp/instance';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';

import type { McpHttpHandler } from '@modelcontextprotocol/server';

const state: { handler?: McpHttpHandler } = {};

/** The MCP HTTP handler. */
export function getMcpHandler(): McpHttpHandler {
  if (state.handler === undefined) {
    const secret = getEnv().AUTH_SECRET;
    state.handler = createMcpHttpHandler({
      runs: getExecution().runs,
      approvals: getGovernance().approvals,
      scope: new WorkspaceScope({ memberships: new MembershipRepo(getDb()) }),
      settings: getMcpSettings(),
      confirmations: secret === undefined ? undefined : createConfirmations(secret),
    });
  }
  return state.handler;
}
