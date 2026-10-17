// A real MCP HTTP handler over pglite with the real feedback domain, for the feedback tool tests.
//
// Ada is a member of `mine`, a workspace with the feedback product on, a project and agents
// allowed to make changes; Eve of `theirs`, another tenant. Every other domain refuses, so a
// feedback tool that reaches one fails its test. `call` sends one `tools/call` the way a client
// does; `ask` and `answer` are the two rounds of a change's confirmation.
import { randomUUID } from 'node:crypto';

import { Products } from '@mocco/common/project';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { members, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { FeedbackSourceReaders } from '@backend/domain/feedback/IntakeService';
import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { ProjectDomain } from '@backend/domain/project/instance';
import type { Db } from '@backend/infra/db/types';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the feedback tools must not reach another domain');
};

export const SIGN_IN = ['openid', 'profile', 'email', 'offline_access'];
export const WRITE = [...SIGN_IN, 'feedback:write'];

export interface RpcAnswer {
  status?: number;
  wwwAuthenticate?: string;
  result?: {
    resultType?: string;
    isError?: boolean;
    content?: { type: string; text: string }[];
    inputRequests?: Record<string, { method: string; params: { message: string } }>;
    requestState?: string;
  };
}

export interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

export interface Scope {
  workspaceId: string;
  projectId: string;
}

export type Args = Record<string, unknown>;

export const messageOf = (answer: RpcAnswer) => answer.result?.inputRequests?.confirm?.params.message ?? '';
export const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';
export const isAsking = (answer: RpcAnswer) => answer.result?.resultType === 'input_required';

const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });

export interface FeedbackHarness {
  t: TestDb;
  feedback: FeedbackDomain;
  project: ProjectDomain;
  settings: McpSettingsService;
  handler: McpHttpHandler;
  ada: string;
  eve: string;
  mine: Scope;
  theirs: Scope;
  call: (tool: string, args: Args, scopes?: string[], round?: Round) => Promise<RpcAnswer>;
  /** The first round of a change; `asked` is the answer, which should ask. */
  ask: (tool: string, args: Args) => Promise<{ asked: RpcAnswer; requestState: string }>;
  answer: (tool: string, args: Args, requestState: string, isConfirmed?: boolean) => Promise<RpcAnswer>;
  /** Both rounds, saying yes. */
  confirmed: (tool: string, args: Args) => Promise<RpcAnswer>;
  /** The tools as `tools/list` describes them. */
  listTools: () => Promise<{ name: string; annotations?: Record<string, boolean> }[]>;
  close: () => Promise<void>;
}

/** `sources` builds the products' request readers over the harness's database. */
export async function createFeedbackHarness(
  options: { sources?: (db: Db) => FeedbackSourceReaders } = {},
): Promise<FeedbackHarness> {
  const t = await createTestDb();
  let tick = Date.parse('2026-10-17T09:00:00Z');
  const now = () => {
    tick += 1000;
    return new Date(tick);
  };
  const audit = new AuditService({ audit: new AuditRepo(t.db) });
  const feedback = createFeedbackDomain(t.db, {
    audit,
    now,
    ...(options.sources !== undefined && { sources: options.sources(t.db) }),
  });
  const project = createProjectDomain(t.db);

  const person = async (name: string, email: string) =>
    expectOne(await t.db.insert(users).values({ id: randomUUID(), name, email, emailVerified: true }).returning()).id;
  async function addWorkspace(memberId: string): Promise<Scope> {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'member' });
    await project.products.enable(workspaceId, Products.feedback, memberId);
    const created = await project.projects.create(workspaceId, { name: 'Shop', handle: 'shop' });
    return { workspaceId, projectId: created.id };
  }

  const ada = await person('Ada', 'ada@acme.test');
  const eve = await person('Eve', 'eve@acme.test');
  const mine = await addWorkspace(ada);
  const theirs = await addWorkspace(eve);
  const settings = createMcpSettingsService(t.db, audit);
  await settings.setAgentsMayDecide(mine.workspaceId, true, ada);

  const scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
  const handler = createMcpHttpHandler({
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
    feedbackBoards: feedback.feedbackBoards,
    feedbackPosts: feedback.feedbackPosts,
    feedbackShipSuggestions: feedback.feedbackShipSuggestions,
    feedbackChangelog: feedback.feedbackChangelog,
    feedbackVotes: feedback.feedbackVotes,
    feedbackComments: feedback.feedbackComments,
    feedbackSubscriptions: feedback.feedbackSubscriptions,
    feedbackDuplicates: feedback.feedbackDuplicates,
    feedbackIntake: feedback.feedbackIntake,
    feedbackMerges: feedback.feedbackMerges,
    scope,
    projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
    settings,
    confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
  });

  const authInfo = (scopes: string[]) => ({
    token: '',
    clientId: 'agent',
    scopes,
    resource: new URL(RESOURCE),
    extra: { [MCP_USER_ID]: ada },
  });

  async function call(tool: string, args: Args, scopes = SIGN_IN, round: Round = {}): Promise<RpcAnswer> {
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
    const response = await handler.fetch(request, { authInfo: authInfo(scopes) });
    const text = await response.text();
    return {
      status: response.status,
      wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
      ...((text === '' ? {} : JSON.parse(text)) as RpcAnswer),
    };
  }

  async function ask(tool: string, args: Args) {
    const asked = await call(tool, args, WRITE);
    return { asked, requestState: asked.result?.requestState ?? '' };
  }

  const answer = async (tool: string, args: Args, requestState: string, isConfirmed = true) =>
    await call(tool, args, WRITE, { requestState, inputResponses: accepting(isConfirmed) });

  async function confirmed(tool: string, args: Args) {
    const { requestState } = await ask(tool, args);
    return await answer(tool, args, requestState);
  }

  async function listTools() {
    const response = await handler.fetch(
      new Request(RESOURCE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-method': 'tools/list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } }),
      }),
      { authInfo: authInfo(SIGN_IN) },
    );
    const listed = (await response.json()) as {
      result: { tools: { name: string; annotations?: Record<string, boolean> }[] };
    };
    return listed.result.tools;
  }

  return {
    t,
    feedback,
    project,
    settings,
    handler,
    ada,
    eve,
    mine,
    theirs,
    call,
    ask,
    answer,
    confirmed,
    listTools,
    close: async () => {
      await t.close();
    },
  };
}
