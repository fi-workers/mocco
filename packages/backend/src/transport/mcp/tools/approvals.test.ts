// `mocco_approvals_vote` over a real database, through the real HTTP handler.
//
// The deciding tool is only as safe as the wiring around it — the scope challenge, the
// signed confirmation state, the SDK seam that verifies it — so these tests send the
// requests a client sends rather than calling the function: what is proven is what a
// client can actually do.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ApprovalKinds, ApprovalStates } from '@mocco/common/governance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createApprovalService } from '@backend/domain/governance/instance';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { expectOne } from '@backend/infra/db/rows';
import { members, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { VOTE_TOOL } from '@backend/transport/mcp/tools/approvals';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';
const SIGN_IN = ['openid', 'profile', 'email', 'offline_access'];
const WITH_WRITE = [...SIGN_IN, 'approvals:write'];

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the vote tool must not read runs');
};

interface Caller {
  userId: string;
  scopes?: string[];
  clientId?: string;
}

interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

/** The person's answer to the confirmation, as a client sends it back. */
const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });

interface RpcAnswer {
  status: number;
  wwwAuthenticate: string | null;
  result?: {
    resultType?: string;
    isError?: boolean;
    content?: { type: string; text: string }[];
    inputRequests?: Record<string, { method: string; params: { message: string } }>;
    requestState?: string;
  };
  error?: { code: number; message: string };
}

describe('mocco_approvals_vote (pglite, over HTTP)', () => {
  let t: TestDb;
  let audit: AuditService;
  let approvals: ApprovalService;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let workspaceId: string;
  let ada: string;
  let requester: string;

  async function addUser(...roleNames: string[]): Promise<string> {
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'U', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId, role: 'member' });
    const roles = new RoleRepo(t.db);
    const memberships = new RoleMembershipRepo(t.db);
    const existing = await roles.listByWorkspace(workspaceId);
    await Promise.all(
      roleNames.map(async name => {
        const role = existing.find(each => each.name === name) ?? (await roles.create({ workspaceId, name }));
        await memberships.add({ workspaceId, roleId: role.id, userId });
      }),
    );
    return userId;
  }

  async function openRequest() {
    return await approvals.request(workspaceId, {
      kind: ApprovalKinds.review,
      subjectType: 'test.change',
      subjectId: 'app-1',
      action: { minSupportedVersion: '3.0.0' },
      requirements: { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false },
      requestedByUserId: requester,
    });
  }

  async function call(caller: Caller, args: Record<string, unknown>, round: Round = {}): Promise<RpcAnswer> {
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': VOTE_TOOL,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: VOTE_TOOL, arguments: args, _meta: envelope, ...round },
      }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: caller.clientId ?? 'agent',
        scopes: caller.scopes ?? WITH_WRITE,
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: caller.userId },
      },
    });
    const text = await response.text();
    const body = (text === '' ? {} : JSON.parse(text)) as Omit<RpcAnswer, 'status' | 'wwwAuthenticate'>;
    return { status: response.status, wwwAuthenticate: response.headers.get('www-authenticate'), ...body };
  }

  async function votesOn(requestId: string) {
    const { votes } = await approvals.get(workspaceId, requestId);
    return votes;
  }

  /** The first round, which must ask; returns the state to echo. */
  async function ask(caller: Caller, args: Record<string, unknown>): Promise<string> {
    const asked = await call(caller, args);
    expect(asked.result?.resultType).toBe('input_required');
    const state = asked.result?.requestState;
    expect(state).toEqual(expect.any(String));
    return state ?? '';
  }

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    approvals = createApprovalService(t.db, audit);
    settings = createMcpSettingsService(t.db, audit);
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'Acme', slug: randomUUID() }).returning()).id;
    ada = await addUser('release');
    requester = await addUser('release');
    await settings.setAgentsMayDecide(workspaceId, true, ada);
    handler = createMcpHttpHandler({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals,
      gates: { getPending: refuse, resume: refuse },
      scope: new WorkspaceScope({ memberships: new MembershipRepo(t.db) }),
      settings,
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
      statusMonitors: { list: refuse, get: refuse, find: refuse, requestCheck: refuse },
      statusLocations: { list: refuse },
      statusCorrelation: { list: refuse },
      helpPublic: { searchInProject: refuse, siteInProject: refuse, articleInProject: refuse },
      helpFeedback: { helpfulness: refuse },
      messengerInbox: { list: refuse, get: refuse, write: refuse, assign: refuse, assignable: refuse },
      feedbackBoards: { listBoards: refuse, getBoard: refuse },
      feedbackPosts: { list: refuse, get: refuse, requirePost: refuse, setStatus: refuse },
      confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await t.close();
  });

  it('challenges a token without approvals:write for it, keeping the scopes it has', async () => {
    const request = await openRequest();

    const answer = await call({ userId: ada, scopes: SIGN_IN }, { requestId: request.id, decision: 'approve' });

    expect(answer.status).toBe(403);
    expect(answer.wwwAuthenticate).toContain('error="insufficient_scope"');
    expect(answer.wwwAuthenticate).toContain('scope="approvals:write openid profile email offline_access"');
    expect(answer.wwwAuthenticate).toContain(
      'resource_metadata="https://mocco.test/.well-known/oauth-protected-resource/api/mcp"',
    );
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('refuses in a workspace that has not allowed agents to decide, and says where to change it', async () => {
    await settings.setAgentsMayDecide(workspaceId, false, ada);
    const request = await openRequest();

    const answer = await call({ userId: ada }, { requestId: request.id, decision: 'approve' });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('Settings → Agents');
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('asks first: the first call returns a confirmation of exactly what would happen, and votes nothing', async () => {
    const request = await openRequest();

    const answer = await call({ userId: ada }, { requestId: request.id, decision: 'approve', reason: 'checked it' });

    expect(answer.result?.resultType).toBe('input_required');
    const confirm = answer.result?.inputRequests?.confirm;
    expect(confirm?.method).toBe('elicitation/create');
    expect(confirm?.params.message).toContain('Approve this review request as you?');
    expect(confirm?.params.message).toContain('test.change app-1');
    expect(confirm?.params.message).toContain('"minSupportedVersion":"3.0.0"');
    expect(confirm?.params.message).toContain('Reason: checked it');
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('casts the vote once confirmed, as the caller, and the audit chain names them', async () => {
    const request = await openRequest();
    const args = { requestId: request.id, decision: 'approve' };
    const requestState = await ask({ userId: ada }, args);

    const answer = await call({ userId: ada }, args, { requestState, inputResponses: accepting(true) });

    expect(answer.result?.isError).not.toBe(true);
    expect(JSON.parse(textOf(answer))).toMatchObject({ voted: true, state: ApprovalStates.approved, votes: 1 });
    const votes = await votesOn(request.id);
    expect(votes.map(vote => vote.userId)).toEqual([ada]);
    const entries = await audit.list(workspaceId, 0n);
    const approved = entries.find(entry => entry.action === AuditActions.approvalApproved);
    expect(approved?.actorUserId).toBe(ada);
  });

  it('votes nothing when the person declines, cancels or answers no', async () => {
    const request = await openRequest();
    const args = { requestId: request.id, decision: 'approve' };

    const answers = await Promise.all(
      [{ confirm: { action: 'decline' } }, { confirm: { action: 'cancel' } }, accepting(false)].map(
        async inputResponses => {
          const requestState = await ask({ userId: ada }, args);
          return await call({ userId: ada }, args, { requestState, inputResponses });
        },
      ),
    );

    expect(answers.map(answer => JSON.parse(textOf(answer)) as unknown)).toEqual([
      expect.objectContaining({ voted: false }),
      expect.objectContaining({ voted: false }),
      expect.objectContaining({ voted: false }),
    ]);
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('refuses a state that was tampered with', async () => {
    const request = await openRequest();
    const args = { requestId: request.id, decision: 'approve' };
    const requestState = await ask({ userId: ada }, args);
    const [version, body = '', mac] = requestState.split('.');
    const forged = [version, `${body.slice(0, -2)}AA`, mac].join('.');

    const answer = await call({ userId: ada }, args, { requestState: forged, inputResponses: accepting(true) });

    expect(answer.error?.code).toBe(-32_602);
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('refuses a state minted for someone else, or for another app of the same person', async () => {
    const request = await openRequest();
    const args = { requestId: request.id, decision: 'approve' };
    const bob = await addUser('release');
    const requestState = await ask({ userId: bob }, args);

    const asAda = await call({ userId: ada }, args, { requestState, inputResponses: accepting(true) });
    const fromAnotherApp = await call({ userId: bob, clientId: 'other-agent' }, args, {
      requestState,
      inputResponses: accepting(true),
    });

    expect(asAda.error?.code).toBe(-32_602);
    expect(fromAnotherApp.error?.code).toBe(-32_602);
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('refuses a state past its five minutes', async () => {
    const request = await openRequest();
    const args = { requestId: request.id, decision: 'approve' };
    vi.useFakeTimers({ toFake: ['Date'], now: new Date() });
    const requestState = await ask({ userId: ada }, args);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    const answer = await call({ userId: ada }, args, { requestState, inputResponses: accepting(true) });

    expect(answer.error?.code).toBe(-32_602);
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('refuses a confirmation of one decision carried into another', async () => {
    const request = await openRequest();
    const requestState = await ask({ userId: ada }, { requestId: request.id, decision: 'reject' });

    const answer = await call(
      { userId: ada },
      { requestId: request.id, decision: 'approve' },
      { requestState, inputResponses: accepting(true) },
    );

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('different vote');
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('still lets the role check refuse someone the request does not allow', async () => {
    const request = await openRequest();
    const outsider = await addUser();
    const args = { requestId: request.id, decision: 'approve' };
    const requestState = await ask({ userId: outsider }, args);

    const answer = await call({ userId: outsider }, args, { requestState, inputResponses: accepting(true) });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('not in a role authorized to approve');
    expect(await votesOn(request.id)).toEqual([]);
  });

  it('will not let the requester approve their own change', async () => {
    const request = await openRequest();
    const args = { requestId: request.id, decision: 'approve' };
    const requestState = await ask({ userId: requester }, args);

    const answer = await call({ userId: requester }, args, { requestState, inputResponses: accepting(true) });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('cannot approve a change you requested');
  });

  it('says a decided request is decided rather than asking about it', async () => {
    const request = await openRequest();
    await approvals.vote(workspaceId, request.id, ada, 'reject');

    const answer = await call({ userId: ada }, { requestId: request.id, decision: 'approve' });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('no longer pending');
  });
});
