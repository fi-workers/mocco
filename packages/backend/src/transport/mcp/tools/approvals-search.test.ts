// `mocco_approvals_search` over a real database, through the real HTTP handler.
//
// An agent reads the approval queue the way Home does: each request carries a short label
// of its subject, named by the product that owns it (#451), so "what is waiting" can be
// answered without a lookup per request.
import { ApprovalKinds } from '@mocco/common/governance';
import { OtaApprovalSubjects } from '@mocco/common/ota';
import { OtaHostingApprovalSubjects } from '@mocco/common/ota-hosting';
import { AppPlatforms } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { members } from '@backend/infra/db/schema';
import { createOtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';
import type { GateRequirements } from '@mocco/common/governance';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';
const TOOL = 'mocco_approvals_search';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const gate: GateRequirements = { resume: [{ role: 'release', count: 1 }], prevent_self: false, reason_required: false };

const refuse = () => {
  throw new Error('the approvals search must not reach another domain');
};

interface RpcAnswer {
  result?: { isError?: boolean; content?: { type: string; text: string }[] };
  error?: { code: number; message: string };
}

interface Listed {
  id: string;
  subject: { type: string; id: string };
  subjectLabel: string | null;
}

describe('mocco_approvals_search (pglite, over HTTP)', () => {
  let f: OtaFixture;
  let handler: McpHttpHandler;

  async function search(args: Record<string, unknown> = {}): Promise<Listed[]> {
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': TOOL,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: TOOL, arguments: args, _meta: envelope },
      }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: 'agent',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: f.ownerId },
      },
    });
    const answer = JSON.parse(await response.text()) as RpcAnswer;
    const text = answer.result?.content?.map(each => each.text).join('\n') ?? '';
    expect(answer.result?.isError, text).not.toBe(true);
    return (JSON.parse(text) as { requests: Listed[] }).requests;
  }

  const open = async (subjectType: string, subjectId: string) =>
    await f.approvals.request(f.workspaceId, {
      projectId: f.projectId,
      kind: ApprovalKinds.preApproval,
      subjectType,
      subjectId,
      action: {},
      requirements: gate,
      requestedByUserId: null,
    });

  beforeEach(async () => {
    f = await createOtaFixture();
    await f.t.db.insert(members).values({ organizationId: f.workspaceId, userId: f.ownerId, role: 'owner' });
    const scope = new WorkspaceScope({ memberships: new MembershipRepo(f.t.db) });
    handler = createMcpHttpHandler({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals: f.approvals,
      gates: { getPending: refuse, resume: refuse },
      flags: { listFlags: refuse, listEnvironments: refuse, history: refuse },
      scope,
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
      statusMonitors: { list: refuse, get: refuse, find: refuse, requestCheck: refuse },
      statusLocations: { list: refuse },
      statusCorrelation: { list: refuse },
      helpPublic: { searchInProject: refuse, siteInProject: refuse, articleInProject: refuse },
      helpFeedback: { helpfulness: refuse },
      helpTranslations: { grid: refuse, reviewByShortId: refuse },
      helpGlossary: { list: refuse },
      messengerInbox: { list: refuse, get: refuse, write: refuse, assign: refuse, assignable: refuse },
      feedbackBoards: { listBoards: refuse, getBoard: refuse },
      feedbackPosts: { list: refuse, get: refuse, requirePost: refuse, setStatus: refuse },
      feedbackVotes: { list: refuse, find: refuse, vote: refuse },
      feedbackComments: { listForStaff: refuse, createAsStaff: refuse },
      feedbackMerges: { merge: refuse },
      settings: { agentsMayDecide: refuse },
      confirmations: undefined,
    });
  });
  afterEach(async () => {
    await f.close();
  });

  it("names each pending request's subject, as Home does", async () => {
    const storeApp = await createProjectDomain(f.t.db).projects.addApp(f.workspaceId, f.projectId, {
      platform: AppPlatforms.ios,
      name: 'Shopper',
    });
    const channel = await f.ota.otaHosting.createChannel(f.appRow, f.ownerId, { name: 'production', policy: null });
    const versionPolicy = await open(OtaApprovalSubjects.versionPolicy, storeApp.id);
    const channelPolicy = await open(OtaHostingApprovalSubjects.channelPolicy, channel.id);
    const unnamed = await open('test.change', 'app-1');

    const requests = await search();
    const listed = new Map(requests.map(request => [request.id, request]));

    expect(listed.get(versionPolicy.id)).toMatchObject({
      subject: { type: OtaApprovalSubjects.versionPolicy, id: storeApp.id },
      subjectLabel: 'Shopper (iOS)',
    });
    expect(listed.get(channelPolicy.id)?.subjectLabel).toBe('production channel');
    // No product names this subject: it is listed, without a label.
    expect(listed.get(unnamed.id)?.subjectLabel).toBeNull();
  });

  it('keeps the label under a subject type filter', async () => {
    const storeApp = await createProjectDomain(f.t.db).projects.addApp(f.workspaceId, f.projectId, {
      platform: AppPlatforms.android,
      name: 'Shopper',
    });
    await open(OtaApprovalSubjects.versionPolicy, storeApp.id);
    await open('test.change', 'app-1');

    const listed = await search({ subjectType: OtaApprovalSubjects.versionPolicy });

    expect(listed.map(request => request.subjectLabel)).toEqual(['Shopper (Android)']);
  });
});
