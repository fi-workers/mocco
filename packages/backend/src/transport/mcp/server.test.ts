// The server builds, and building it registers tools without reaching a service.
//
// There is deliberately no assertion here about tool *names*: writing the names out and
// checking they match themselves tests the test. What each tool does is covered where it
// is implemented, against a real database.
import { describe, expect, it } from 'vitest';

import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createMcpServer } from '@backend/transport/mcp/server';

const refuse = () => {
  throw new Error('registration must not call a service');
};

describe('createMcpServer', () => {
  it('registers its tools without calling anything', () => {
    const server = createMcpServer({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals: { list: refuse, get: refuse, vote: refuse },
      gates: { getPending: refuse, resume: refuse },
      scope: new WorkspaceScope({ memberships: { listForUser: refuse, isMember: refuse } }),
      settings: { agentsMayDecide: refuse },
      flags: { listFlags: refuse, listEnvironments: refuse, history: refuse },
      projects: { resolve: refuse, resolveWorkspace: refuse },
      otaHosting: { listApps: refuse, requireApp: refuse, listChannels: refuse },
      otaChannels: { listHeads: refuse },
      otaReleases: { listReleases: refuse },
      otaMetrics: { channelReach: refuse, monthlyActiveDevices: refuse },
      versionPolicies: { get: refuse, listChanges: refuse },
      projectApps: { listApps: refuse },
      statusPages: { listPages: refuse, getPage: refuse },
      statusIncidents: { list: refuse, get: refuse },
      statusMaintenances: { list: refuse },
      statusMonitors: { list: refuse, get: refuse, requestCheck: refuse },
      statusLocations: { list: refuse },
      statusCorrelation: { list: refuse },
      helpPublic: { searchInProject: refuse, siteInProject: refuse, articleInProject: refuse },
      helpFeedback: { helpfulness: refuse },
      confirmations: undefined,
    });

    expect(server).toBeDefined();
  });
});
