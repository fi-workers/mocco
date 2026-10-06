// The MCP server: registers the tools and nothing else.
//
// It is a transport (ADR 0011, ADR 0025). It holds no business rules — every tool calls
// one domain service with the caller's own identity, and that service's checks are the
// only authority. Composition is `runtime/mcp.ts`, above the domains.
//
// Two tools decide (`mocco_approvals_vote`, `mocco_gates_resume`), five change
// notification settings (`tools/notifications-write.ts`) and four change webhook sources
// (`tools/inbound-write.ts`); each is gated by scope, by the
// workspace's opt-in and by a confirmation round trip whose signed state is verified
// here, before any tool sees it. `mocco_monitors_check` (in `tools/status-monitors.ts`) has the
// same locks under its own `status:write` scope, and `mocco_messenger_reply` and
// `mocco_messenger_assign` (in `tools/messenger.ts`) under `messenger:write`, and
// `mocco_feedback_post_set_status` (in `tools/feedback.ts`) and `mocco_feedback_comment_create`,
// `mocco_feedback_post_vote` and `mocco_feedback_post_merge` (in `tools/feedback-engagement.ts`)
// under `feedback:write`, and `mocco_help_translation_accept`, `mocco_help_translation_retranslate`
// and `mocco_help_glossary_set` (in `tools/help-write.ts`) under `help:write`.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

import { registerApprovalTools, type ApprovalToolDeps } from '@backend/transport/mcp/tools/approvals';
import { registerFeedbackTools, type FeedbackToolDeps } from '@backend/transport/mcp/tools/feedback';
import {
  registerFeedbackEngagementTools,
  type FeedbackEngagementToolDeps,
} from '@backend/transport/mcp/tools/feedback-engagement';
import { registerFlagTools, type FlagToolDeps } from '@backend/transport/mcp/tools/flags';
import { registerGateTools, type GateToolDeps } from '@backend/transport/mcp/tools/gates';
import { registerHelpTools, type HelpToolDeps } from '@backend/transport/mcp/tools/help';
import { registerHelpWriteTools, type HelpWriteToolDeps } from '@backend/transport/mcp/tools/help-write';
import { registerInboundTools, type InboundToolDeps } from '@backend/transport/mcp/tools/inbound';
import { registerInboundWriteTools, type InboundWriteToolDeps } from '@backend/transport/mcp/tools/inbound-write';
import { registerMessengerTools, type MessengerToolDeps } from '@backend/transport/mcp/tools/messenger';
import { registerNotificationTools, type NotificationToolDeps } from '@backend/transport/mcp/tools/notifications';
import {
  registerNotificationWriteTools,
  type NotificationWriteToolDeps,
} from '@backend/transport/mcp/tools/notifications-write';
import { registerOtaTools, type OtaToolDeps } from '@backend/transport/mcp/tools/ota';
import { registerRunTools, type RunToolDeps } from '@backend/transport/mcp/tools/runs';
import { registerStatusTools, type StatusToolDeps } from '@backend/transport/mcp/tools/status';
import { registerStatusMonitorTools, type StatusMonitorToolDeps } from '@backend/transport/mcp/tools/status-monitors';

import type { McpHttpHandler } from '@modelcontextprotocol/server';

export type McpToolDeps = RunToolDeps &
  ApprovalToolDeps &
  GateToolDeps &
  FlagToolDeps &
  OtaToolDeps &
  StatusToolDeps &
  StatusMonitorToolDeps &
  HelpToolDeps &
  HelpWriteToolDeps &
  MessengerToolDeps &
  FeedbackToolDeps &
  FeedbackEngagementToolDeps &
  NotificationToolDeps &
  NotificationWriteToolDeps &
  InboundToolDeps &
  InboundWriteToolDeps;

/** The server name and version a client sees in `initialize`. */
const SERVER_INFO = { name: 'mocco', version: '0.1.0' } as const;

export function createMcpServer(deps: McpToolDeps): McpServer {
  const { confirmations } = deps;
  const server = new McpServer(SERVER_INFO, {
    // A state that fails verification is refused by the SDK with a fixed -32602 before
    // the tool runs; the tool then reads back the verified payload, never the raw string.
    ...(confirmations !== undefined && {
      requestState: { verify: async (state, ctx) => await confirmations.verify(state, ctx) },
    }),
  });
  registerRunTools(server, deps);
  registerApprovalTools(server, deps);
  registerGateTools(server, deps);
  registerFlagTools(server, deps);
  registerOtaTools(server, deps);
  registerStatusTools(server, deps);
  registerStatusMonitorTools(server, deps);
  registerHelpTools(server, deps);
  registerHelpWriteTools(server, deps);
  registerMessengerTools(server, deps);
  registerFeedbackTools(server, deps);
  registerFeedbackEngagementTools(server, deps);
  registerNotificationTools(server, deps);
  registerNotificationWriteTools(server, deps);
  registerInboundTools(server, deps);
  registerInboundWriteTools(server, deps);
  return server;
}

/**
 * The HTTP handler over a fresh server per request. `legacy: 'reject'` serves the
 * 2026-07-28 revision only: the older HTTP+SSE transport is deprecated with a
 * twelve-month window, and carrying a second protocol era would mean a second set of
 * behaviours to reason about on a surface that can reach production.
 */
export function createMcpHttpHandler(deps: McpToolDeps): McpHttpHandler {
  return createMcpHandler(() => createMcpServer(deps), { legacy: 'reject' });
}
