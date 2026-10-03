// Composition root for the MCP server — above the domains, like the job runner.
//
// It builds the per-request server from the domain services. `createMcpHandler` asks for
// one instance per request because the 2026-07-28 protocol is stateless: there is no
// session to keep, and any request may land on any deployment.
import { createMcpHandler } from '@modelcontextprotocol/server';

import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { getExecution } from '@backend/domain/execution/instance';
import { getGovernance } from '@backend/domain/governance/instance';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { getDb } from '@backend/infra/db/client';
import { createMcpServer } from '@backend/transport/mcp/server';

import type { McpHttpHandler } from '@modelcontextprotocol/server';

const state: { handler?: McpHttpHandler } = {};

/**
 * The MCP HTTP handler. `legacy: 'reject'` serves the 2026-07-28 revision only: the older
 * HTTP+SSE transport is deprecated with a twelve-month window, and carrying a second
 * protocol era would mean a second set of behaviours to reason about on a surface that
 * can reach production.
 */
export function getMcpHandler(): McpHttpHandler {
  state.handler ??= createMcpHandler(
    () =>
      createMcpServer({
        runs: getExecution().runs,
        approvals: getGovernance().approvals,
        scope: new WorkspaceScope({ memberships: new MembershipRepo(getDb()) }),
      }),
    { legacy: 'reject' },
  );
  return state.handler;
}
