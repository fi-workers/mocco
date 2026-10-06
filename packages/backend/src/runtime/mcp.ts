// Composition root for the MCP server — above the domains, like the job runner.
//
// It builds the per-request server from the domain services. `createMcpHandler` asks for
// one instance per request because the 2026-07-28 protocol is stateless: there is no
// session to keep, and any request may land on any deployment — which is also why the
// confirmation state is signed with a key every deployment derives from the same secret.
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { getExecution } from '@backend/domain/execution/instance';
import { getFeedbackDomain } from '@backend/domain/feedback/instance';
import { getFlagsDomain } from '@backend/domain/flags/instance';
import { getGovernance } from '@backend/domain/governance/instance';
import { getHelpDomain } from '@backend/domain/helpcenter/instance';
import { getInbound } from '@backend/domain/inbound/instance';
import { getMcpSettings } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { getMessengerDomain } from '@backend/domain/messenger/instance';
import { getNotification } from '@backend/domain/notification/instance';
import { getOtaDomain } from '@backend/domain/ota/instance';
import { getProjectDomain } from '@backend/domain/project/instance';
import { getStatusDomain } from '@backend/domain/status/instance';
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
    const scope = new WorkspaceScope({ memberships: new MembershipRepo(getDb()) });
    const { projects, products } = getProjectDomain();
    const ota = getOtaDomain();
    const status = getStatusDomain();
    state.handler = createMcpHttpHandler({
      runs: getExecution().runs,
      approvals: getGovernance().approvals,
      gates: getGovernance().gates,
      flags: getFlagsDomain().flags,
      otaHosting: ota.otaHosting,
      otaChannels: ota.otaChannels,
      otaReleases: ota.otaUploads,
      otaMetrics: ota.otaMetrics,
      versionPolicies: ota.versionPolicies,
      projectApps: projects,
      statusPages: status.statusPages,
      statusIncidents: status.statusIncidents,
      statusMaintenances: status.statusMaintenances,
      statusMonitors: status.statusMonitors,
      statusLocations: status.statusLocations,
      statusCorrelation: status.statusCorrelation,
      helpPublic: getHelpDomain().helpPublic,
      helpFeedback: getHelpDomain().helpFeedback,
      messengerInbox: getMessengerDomain().inbox,
      feedbackBoards: getFeedbackDomain().feedbackBoards,
      feedbackPosts: getFeedbackDomain().feedbackPosts,
      notifications: getNotification().channels,
      notificationActivity: getNotification().activity,
      inbound: getInbound(),
      scope,
      projects: new ProjectScope({ workspaces: scope, projects, products }),
      settings: getMcpSettings(),
      confirmations: secret === undefined ? undefined : createConfirmations(secret),
    });
  }
  return state.handler;
}
