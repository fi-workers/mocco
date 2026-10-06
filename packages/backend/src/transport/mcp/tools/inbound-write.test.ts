// The tools that change webhook sources, over a real database, through the real HTTP
// handler.
//
// Like the other changing tools' tests, these send what a client sends: the scope
// challenge, the signed confirmation state and the SDK seam that verifies it are part of
// what is being proven. A source holds a signing secret, so every answer of every test is
// also checked for it: neither a generated nor a pasted secret, nor its sealed form, may
// ever reach the model.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { InboundKinds, InboundSourceStatuses } from '@mocco/common/inbound';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createInboundHarness } from '@backend/domain/inbound/testing/harness';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { seedWorkspace } from '@backend/domain/notification/testing/seed';
import { expectOne } from '@backend/infra/db/rows';
import { inboundSources, members, users } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { InboundWriteTools } from '@backend/transport/mcp/tools/inbound-write';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { InboundDomain } from '@backend/domain/inbound/instance';
import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { McpToolDeps } from '@backend/transport/mcp/server';
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
  throw new Error('the webhook source tools must not reach another domain');
};

const SENTRY_SECRET = 'sentry-client-secret-do-not-leak';

const CHANGING_TOOLS = [
  InboundWriteTools.create,
  InboundWriteTools.pause,
  InboundWriteTools.resume,
  InboundWriteTools.delete,
];

interface Caller {
  userId: string;
  scopes?: string[];
  clientId?: string;
}

interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

interface RpcAnswer {
  status: number;
  wwwAuthenticate: string | null;
  result?: {
    resultType?: string;
    isError?: boolean;
    content?: { type: string; text: string }[];
    inputRequests?: Record<string, { method: string; params: { message: string } }>;
    requestState?: string;
    tools?: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[];
  };
  error?: { code: number; message: string };
}

type Row = Record<string, unknown>;

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';
const messageOf = (answer: RpcAnswer) => answer.result?.inputRequests?.confirm?.params.message ?? '';

/** The person's answer to the confirmation, as a client sends it back. */
const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });

describe('mocco_inbound_sources_* changes (pglite, over HTTP)', () => {
  let t: TestDb;
  let inbound: InboundDomain & { audit: AuditService };
  let settings: McpSettingsService;
  let scope: WorkspaceScope;
  let handler: McpHttpHandler;
  let workspaceId: string;
  let ada: string;
  let bob: string;
  let carol: string;
  let repo: { id: string };
  let errors: { id: string };
  let secrets: string[];
  /** Every answer of the test, checked for secrets once it is done. */
  let answers: RpcAnswer[];

  const deps = (sources: McpToolDeps['inbound']): McpToolDeps => ({
    runs: { searchInWorkspace: refuse, get: refuse },
    approvals: { listLabeled: refuse, get: refuse, vote: refuse },
    gates: { getPending: refuse, resume: refuse },
    flags: { listFlags: refuse, listEnvironments: refuse, history: refuse },
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
    notifications: undefined,
    notificationActivity: { list: refuse },
    inbound: sources,
    scope,
    projects: { resolve: refuse, resolveWorkspace: refuse },
    settings,
    confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
  });

  async function call(tool: string, args: Record<string, unknown>, round: Round = {}, caller?: Caller) {
    const who = caller ?? { userId: ada };
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': tool,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args, _meta: envelope, ...round },
      }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: who.clientId ?? 'agent',
        scopes: who.scopes ?? WITH_WRITE,
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: who.userId },
      },
    });
    const text = await response.text();
    const body = (text === '' ? {} : JSON.parse(text)) as Omit<RpcAnswer, 'status' | 'wwwAuthenticate'>;
    const answer = { status: response.status, wwwAuthenticate: response.headers.get('www-authenticate'), ...body };
    answers.push(answer);
    return answer;
  }

  async function listTools() {
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: 'agent',
        scopes: WITH_WRITE,
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: ada },
      },
    });
    const body = (await response.json()) as RpcAnswer;
    return body.result?.tools ?? [];
  }

  /** The first round, which must ask; returns the state to echo. */
  async function ask(tool: string, args: Record<string, unknown>, caller?: Caller) {
    const asked = await call(tool, args, {}, caller);
    expect(asked.result?.resultType, textOf(asked)).toBe('input_required');
    return asked.result?.requestState ?? '';
  }

  /** Ask, then answer yes: the whole confirmed change. */
  async function confirmed(tool: string, args: Record<string, unknown>, caller?: Caller) {
    const requestState = await ask(tool, args, caller);
    return await call(tool, args, { requestState, inputResponses: accepting(true) }, caller);
  }

  const bodyOf = (answer: RpcAnswer) => {
    expect(answer.result?.isError, textOf(answer)).not.toBe(true);
    return JSON.parse(textOf(answer)) as Row;
  };

  const addUser = async (role: string, workspace = workspaceId) => {
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'U', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspace, userId, role });
    return userId;
  };

  const sourcesNow = async () => {
    const listed = await inbound.sources.list(workspaceId);
    return listed.map(source => [source.name, source.status]);
  };
  const actorsOf = async (action: string) => {
    const entries = await inbound.audit.list(workspaceId, 0n);
    return entries.filter(entry => entry.action === action).map(entry => entry.actorUserId);
  };

  beforeEach(async () => {
    t = await createTestDb();
    answers = [];
    inbound = createInboundHarness(t.db);
    settings = createMcpSettingsService(t.db, inbound.audit);
    scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    workspaceId = await seedWorkspace(t.db, 'Acme');
    ada = await addUser('owner');
    bob = await addUser('member');
    carol = await addUser('member,admin');
    const github = await inbound.sources.create(workspaceId, ada, { kind: InboundKinds.github, name: 'repo' });
    repo = github.source;
    ({ source: errors } = await inbound.sources.create(workspaceId, ada, {
      kind: InboundKinds.sentry,
      name: 'errors',
      secret: SENTRY_SECRET,
    }));
    const rows = await t.db.select().from(inboundSources);
    secrets = [github.generatedSecret ?? '', SENTRY_SECRET, ...rows.map(row => row.secretSealed)];
    await settings.setAgentsMayDecide(workspaceId, true, ada);
    handler = createMcpHttpHandler(deps(inbound));
  });
  afterEach(async () => {
    // Sources created during the test have secrets too.
    const rows = await t.db.select().from(inboundSources);
    const everything = answers.map(answer => JSON.stringify(answer)).join('\n');
    expect([...secrets, ...rows.map(row => row.secretSealed)].filter(value => everything.includes(value))).toEqual([]);
    expect(everything).not.toMatch(/secretSealed|secret_sealed|generatedSecret/u);
    await t.close();
  });

  it('declares every tool as a change, and delete as destructive', async () => {
    const tools = await listTools();
    const annotationsOf = (name: string) => tools.find(tool => tool.name === name)?.annotations;

    expect(CHANGING_TOOLS.map(name => annotationsOf(name)?.readOnlyHint)).toEqual([false, false, false, false]);
    expect(annotationsOf(InboundWriteTools.delete)?.destructiveHint).toBe(true);
  });

  describe('the locks in front of every change', () => {
    it('challenges a token without approvals:write for it, keeping the scopes it has', async () => {
      const answer = await call(InboundWriteTools.pause, { sourceId: repo.id }, {}, { userId: ada, scopes: SIGN_IN });

      expect(answer.status).toBe(403);
      expect(answer.wwwAuthenticate).toContain('error="insufficient_scope"');
      expect(answer.wwwAuthenticate).toContain('scope="approvals:write openid profile email offline_access"');
      expect(await sourcesNow()).toEqual([
        ['repo', InboundSourceStatuses.active],
        ['errors', InboundSourceStatuses.active],
      ]);
    });

    it('refuses in a workspace that has not allowed agents to make changes, and says where to change it', async () => {
      await settings.setAgentsMayDecide(workspaceId, false, ada);

      const answer = await call(InboundWriteTools.delete, { sourceId: repo.id });

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain('Agents may not change webhook sources in this workspace');
      expect(textOf(answer)).toContain('Settings → Agents');
      expect(await sourcesNow()).toHaveLength(2);
    });

    it('refuses a plain member before asking anything, as the console does', async () => {
      const asBob = { userId: bob };

      const refusals = await Promise.all([
        call(InboundWriteTools.create, { kind: 'github', name: 'web' }, {}, asBob),
        call(InboundWriteTools.pause, { sourceId: repo.id }, {}, asBob),
        call(InboundWriteTools.resume, { sourceId: repo.id }, {}, asBob),
        call(InboundWriteTools.delete, { sourceId: repo.id }, {}, asBob),
      ]);

      expect(refusals.map(answer => answer.result?.isError)).toEqual([true, true, true, true]);
      expect(refusals.every(answer => textOf(answer).includes('Only an owner or admin'))).toBe(true);
      expect(refusals.some(answer => answer.result?.resultType === 'input_required')).toBe(false);
      expect(await sourcesNow()).toHaveLength(2);
    });

    it('lets an admin whose roles are stored comma-joined through, like the console', async () => {
      const answer = await confirmed(InboundWriteTools.pause, { sourceId: repo.id }, { userId: carol });

      expect(bodyOf(answer)).toMatchObject({ changed: true });
      expect(await actorsOf(AuditActions.inboundSourcePaused)).toEqual([carol]);
    });

    it('refuses a workspace the caller is not in exactly as one that does not exist', async () => {
      const theirs = await seedWorkspace(t.db, 'Globex');
      await addUser('owner', theirs);
      const nowhere = randomUUID();

      const foreign = await call(InboundWriteTools.pause, { workspaceId: theirs, sourceId: randomUUID() });
      const missing = await call(InboundWriteTools.pause, { workspaceId: nowhere, sourceId: randomUUID() });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('No workspace');
      expect(textOf(foreign).replace(theirs, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
    });

    it('says why when this server has no inbound webhooks', async () => {
      handler = createMcpHttpHandler(deps(undefined));

      const answer = await call(InboundWriteTools.pause, { sourceId: repo.id });

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain('Inbound webhooks are not configured on this Mocco server');
      expect(textOf(answer)).toContain('SECRETS_ENCRYPTION_KEYS');
    });
  });

  describe('the confirmation', () => {
    it('asks first, showing exactly what would change, and changes nothing', async () => {
      const answer = await call(InboundWriteTools.pause, { sourceId: repo.id });

      expect(answer.result?.resultType).toBe('input_required');
      expect(answer.result?.inputRequests?.confirm?.method).toBe('elicitation/create');
      expect(messageOf(answer)).toBe(
        [
          'Pause this webhook source, as you?',
          `Source: repo (github, ${repo.id})`,
          'Now: active',
          'While paused, its deliveries are refused and nothing is recorded or sent.',
        ].join('\n'),
      );
      expect(await sourcesNow()).toEqual([
        ['repo', InboundSourceStatuses.active],
        ['errors', InboundSourceStatuses.active],
      ]);
      expect(await actorsOf(AuditActions.inboundSourcePaused)).toEqual([]);
    });

    it('changes nothing when the person declines, cancels or answers no', async () => {
      const args = { sourceId: repo.id };

      const replies = await Promise.all(
        [{ confirm: { action: 'decline' } }, { confirm: { action: 'cancel' } }, accepting(false)].map(
          async inputResponses => {
            const requestState = await ask(InboundWriteTools.delete, args);
            return await call(InboundWriteTools.delete, args, { requestState, inputResponses });
          },
        ),
      );

      expect(replies.map(answer => bodyOf(answer))).toEqual([
        expect.objectContaining({ changed: false }),
        expect.objectContaining({ changed: false }),
        expect.objectContaining({ changed: false }),
      ]);
      expect(await sourcesNow()).toHaveLength(2);
    });

    it('refuses a state that was tampered with', async () => {
      const args = { sourceId: repo.id };
      const requestState = await ask(InboundWriteTools.delete, args);
      const [version, body = '', mac] = requestState.split('.');
      const forged = [version, `${body.slice(0, -2)}AA`, mac].join('.');

      const answer = await call(InboundWriteTools.delete, args, {
        requestState: forged,
        inputResponses: accepting(true),
      });

      expect(answer.error?.code).toBe(-32_602);
      expect(await sourcesNow()).toHaveLength(2);
    });

    it('refuses a state minted for someone else, or for another app of the same person', async () => {
      const args = { sourceId: repo.id };
      const requestState = await ask(InboundWriteTools.delete, args, { userId: carol });

      const asAda = await call(InboundWriteTools.delete, args, { requestState, inputResponses: accepting(true) });
      const fromAnotherApp = await call(
        InboundWriteTools.delete,
        args,
        { requestState, inputResponses: accepting(true) },
        { userId: carol, clientId: 'other-agent' },
      );

      expect(asAda.error?.code).toBe(-32_602);
      expect(fromAnotherApp.error?.code).toBe(-32_602);
      expect(await sourcesNow()).toHaveLength(2);
    });

    it("refuses one tool's confirmation carried into another, or into another source", async () => {
      const requestState = await ask(InboundWriteTools.pause, { sourceId: repo.id });

      const otherTool = await call(
        InboundWriteTools.delete,
        { sourceId: repo.id },
        { requestState, inputResponses: accepting(true) },
      );
      const otherSource = await call(
        InboundWriteTools.pause,
        { sourceId: errors.id },
        { requestState, inputResponses: accepting(true) },
      );

      expect([otherTool, otherSource].map(answer => answer.result?.isError)).toEqual([true, true]);
      expect(textOf(otherTool)).toContain('different change');
      expect(textOf(otherSource)).toContain('different change');
      expect(await sourcesNow()).toEqual([
        ['repo', InboundSourceStatuses.active],
        ['errors', InboundSourceStatuses.active],
      ]);
    });
  });

  describe('each change', () => {
    it('adds a GitHub source once confirmed, as the caller, and never returns its secret', async () => {
      const asked = await call(InboundWriteTools.create, { kind: 'github', name: 'web' });
      const done = await call(
        InboundWriteTools.create,
        { kind: 'github', name: 'web' },
        { requestState: asked.result?.requestState ?? '', inputResponses: accepting(true) },
      );

      expect(messageOf(asked)).toContain('Add a GitHub webhook source to this workspace, as you?');
      expect(messageOf(asked)).toContain('Name: web');
      expect(messageOf(asked)).toContain('does not show it to the agent');
      const body = bodyOf(done);
      expect(body).toEqual({
        changed: true,
        source: {
          id: expect.any(String),
          kind: InboundKinds.github,
          name: 'web',
          status: InboundSourceStatuses.active,
          ingestUrl: expect.stringMatching(/\/api\/ext\/inbound\/[\w-]{43}$/u),
        },
        secret: expect.stringContaining("rotate this source's secret"),
      });
      expect(await sourcesNow()).toContainEqual(['web', InboundSourceStatuses.active]);
      expect(await actorsOf(AuditActions.inboundSourceCreated)).toEqual([ada, ada, ada]);
    });

    it('applies a confirmed add once: sending the same answer again adds nothing', async () => {
      const args = { kind: 'github', name: 'web' };
      const requestState = await ask(InboundWriteTools.create, args);

      const first = await call(InboundWriteTools.create, args, { requestState, inputResponses: accepting(true) });
      const replay = await call(InboundWriteTools.create, args, { requestState, inputResponses: accepting(true) });

      expect(bodyOf(first)).toMatchObject({ changed: true });
      expect(replay.result?.isError).toBe(true);
      expect(textOf(replay)).toContain('already exists');
      expect(await sourcesNow()).toHaveLength(3);
    });

    it.each(['sentry', 'vercel'])('refuses a %s source with a pointer to the console, before asking', async kind => {
      const answer = await call(InboundWriteTools.create, { kind, name: 'web' });

      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.resultType).not.toBe('input_required');
      expect(textOf(answer)).toContain('Notifications → Sources in the Mocco console');
      expect(textOf(answer)).toContain('a secret must never pass through an agent');
      expect(await sourcesNow()).toHaveLength(2);
    });

    it('pauses and resumes a source, each audited as the caller', async () => {
      const paused = await confirmed(InboundWriteTools.pause, { sourceId: repo.id });
      const askedResume = await call(InboundWriteTools.resume, { sourceId: repo.id });
      const resumed = await confirmed(InboundWriteTools.resume, { sourceId: repo.id });

      expect(bodyOf(paused)).toMatchObject({ changed: true, source: { status: InboundSourceStatuses.paused } });
      expect(messageOf(askedResume)).toContain('Now: paused');
      expect(bodyOf(resumed)).toMatchObject({ changed: true, source: { status: InboundSourceStatuses.active } });
      expect(await actorsOf(AuditActions.inboundSourcePaused)).toEqual([ada]);
      expect(await actorsOf(AuditActions.inboundSourceResumed)).toEqual([ada]);
    });

    it('deletes a source, and a replayed confirmation finds nothing to delete', async () => {
      const args = { sourceId: errors.id };
      const asked = await call(InboundWriteTools.delete, args);
      const requestState = await ask(InboundWriteTools.delete, args);

      const done = await call(InboundWriteTools.delete, args, { requestState, inputResponses: accepting(true) });
      const replay = await call(InboundWriteTools.delete, args, { requestState, inputResponses: accepting(true) });

      expect(messageOf(asked)).toContain(`Source: errors (sentry, ${errors.id})`);
      expect(messageOf(asked)).toContain('This cannot be undone.');
      expect(bodyOf(done)).toEqual({ changed: true, deletedSourceId: errors.id });
      expect(replay.result?.isError).toBe(true);
      expect(textOf(replay)).toContain('not found');
      expect(await sourcesNow()).toEqual([['repo', InboundSourceStatuses.active]]);
      expect(await actorsOf(AuditActions.inboundSourceDeleted)).toEqual([ada]);
    });
  });
});
