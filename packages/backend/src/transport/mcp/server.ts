// The MCP server: registers the tools and nothing else.
//
// It is a transport (ADR 0011, ADR 0025). It holds no business rules — every tool calls
// one domain service with the caller's own identity, and that service's checks are the
// only authority. Composition is `runtime/mcp.ts`, above the domains.
//
// Read-only today. The deciding tools arrive with their confirmation round trip and the
// per-workspace opt-in that governs them; until then this server cannot change anything.
import { McpServer } from '@modelcontextprotocol/server';

import { registerApprovalTools, type ApprovalToolDeps } from '@backend/transport/mcp/tools/approvals';
import { registerRunTools, type RunToolDeps } from '@backend/transport/mcp/tools/runs';

export type McpToolDeps = RunToolDeps & ApprovalToolDeps;

/** The server name and version a client sees in `initialize`. */
const SERVER_INFO = { name: 'mocco', version: '0.1.0' } as const;

export function createMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerRunTools(server, deps);
  registerApprovalTools(server, deps);
  return server;
}
