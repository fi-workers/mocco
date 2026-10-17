// `mocco_projects_search` and the project setup changes over a real database, through the
// real HTTP handler: what each creates, and that nothing is created without `projects:write`,
// the workspace's opt-in and a confirmed round trip, or in a workspace the caller is not in.
import { randomUUID } from 'node:crypto';

import { AppPlatforms, Products } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
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

import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { ProjectDomain } from '@backend/domain/project/instance';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the project tools must not reach another domain');
};

interface RpcAnswer {
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

interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });

const messageOf = (answer: RpcAnswer) => answer.result?.inputRequests?.confirm?.params.message ?? '';

const SIGN_IN = ['openid', 'profile', 'email', 'offline_access'];
const WITH_PROJECTS_WRITE = [...SIGN_IN, 'projects:write'];

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

function bodyOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Record<string, unknown>;
}

type Row = Record<string, unknown>;

describe('mocco_projects_* and mocco_products_enable (pglite, over HTTP)', () => {
  let t: TestDb;
  let project: ProjectDomain;
  let handler: McpHttpHandler;
  let settings: McpSettingsService;
  let workspaceId: string;
  let ada: string;

  async function call(
    tool: string,
    args: Record<string, unknown>,
    options: { userId?: string; scopes?: string[]; round?: Round } = {},
  ): Promise<RpcAnswer> {
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
        params: { name: tool, arguments: args, _meta: envelope, ...options.round },
      }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: 'agent',
        scopes: options.scopes ?? WITH_PROJECTS_WRITE,
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: options.userId ?? ada },
      },
    });
    const text = await response.text();
    return {
      status: response.status,
      wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
      ...((text === '' ? {} : JSON.parse(text)) as RpcAnswer),
    };
  }

  async function ask(tool: string, args: Record<string, unknown>) {
    const asked = await call(tool, args);
    expect(asked.result?.resultType, textOf(asked)).toBe('input_required');
    return { asked, requestState: asked.result?.requestState ?? '' };
  }

  async function confirmed(tool: string, args: Record<string, unknown>, isConfirmed = true) {
    const { requestState } = await ask(tool, args);
    return await call(tool, args, { round: { requestState, inputResponses: accepting(isConfirmed) } });
  }

  const search = async (args: Record<string, unknown> = {}) =>
    bodyOf(await call('mocco_projects_search', args, { scopes: SIGN_IN }));

  async function addUser(name: string) {
    const row = await t.db
      .insert(users)
      .values({ id: randomUUID(), name, email: `${randomUUID()}@acme.test`, emailVerified: true })
      .returning();
    return expectOne(row).id;
  }

  beforeEach(async () => {
    t = await createTestDb();
    project = createProjectDomain(t.db);
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    ada = await addUser('Ada');
    await t.db.insert(members).values({ organizationId: workspaceId, userId: ada, role: 'member' });
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    settings = createMcpSettingsService(t.db, audit);
    await settings.setAgentsMayDecide(workspaceId, true, ada);

    const scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    handler = createMcpHttpHandler({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals: { listLabeled: refuse, get: refuse, vote: refuse },
      gates: { getPending: refuse, resume: refuse },
      flags: { listFlags: refuse, listEnvironments: refuse, history: refuse },
      scope,
      projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
      otaHosting: { listApps: refuse, requireApp: refuse, listChannels: refuse },
      otaChannels: { listHeads: refuse },
      otaReleases: { listReleases: refuse },
      otaMetrics: { channelReach: refuse, monthlyActiveDevices: refuse },
      versionPolicies: { get: refuse, listChanges: refuse },
      projectSetup: { projects: project.projects, products: project.products },
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
      feedbackBoards: {
        listBoards: refuse,
        getBoard: refuse,
        createBoard: refuse,
        updateBoard: refuse,
        setReleasePolicy: refuse,
        createCategory: refuse,
        updateCategory: refuse,
        deleteCategory: refuse,
      },
      feedbackPosts: {
        list: refuse,
        get: refuse,
        requirePost: refuse,
        setStatus: refuse,
        create: refuse,
        update: refuse,
      },
      feedbackShipSuggestions: { listPending: refuse, accept: refuse, dismiss: refuse },
      feedbackChangelog: { get: refuse },
      feedbackVotes: { list: refuse, find: refuse, vote: refuse, unvote: refuse },
      feedbackComments: { listForStaff: refuse, createAsStaff: refuse },
      feedbackSubscriptions: { list: refuse },
      feedbackDuplicates: { list: refuse, countOpen: refuse, requireOpen: refuse, dismiss: refuse },
      feedbackIntake: { preview: refuse, convert: refuse, postsOf: refuse, sourcesOf: refuse },
      feedbackMerges: { merge: refuse },
      settings,
      confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('starts from an empty workspace and says what to do first', async () => {
    const body = await search();

    expect(body).toMatchObject({ workspaceId, products: [Products.governance], projects: [] });
    expect(body.next).toContain('mocco_projects_create');
  });

  it('creates a project, adds a React Native app and turns OTA on, each after the person confirms', async () => {
    const { asked } = await ask('mocco_projects_create', { name: 'ShowYourTime', handle: 'showyourtime' });
    expect(messageOf(asked)).toContain('Handle: showyourtime');
    const created = bodyOf(
      await call(
        'mocco_projects_create',
        { name: 'ShowYourTime', handle: 'showyourtime' },
        { round: { requestState: asked.result?.requestState, inputResponses: accepting(true) } },
      ),
    );
    const projectId = (created.project as Row).id;

    const app = { platform: AppPlatforms.reactNative, name: 'ShowYourTime app', bundleId: 'com.acme.sync' };
    // The workspace has one project, so the app's project may be left out.
    const appAsked = await ask('mocco_projects_apps_add', app);
    expect(messageOf(appAsked.asked)).toContain('App: ShowYourTime app (React Native)');
    bodyOf(await confirmed('mocco_projects_apps_add', app));
    bodyOf(await confirmed('mocco_products_enable', { product: Products.ota }));

    const body = await search();
    expect(body.products).toEqual([Products.governance, Products.ota]);
    expect(body.projects).toEqual([
      {
        id: projectId,
        name: 'ShowYourTime',
        handle: 'showyourtime',
        isArchived: false,
        apps: [
          {
            id: expect.any(String),
            platform: AppPlatforms.reactNative,
            name: 'ShowYourTime app',
            bundleId: 'com.acme.sync',
          },
        ],
      },
    ]);
  });

  it('creates nothing when the person says no', async () => {
    expect(bodyOf(await confirmed('mocco_projects_create', { name: 'X', handle: 'x' }, false))).toMatchObject({
      changed: false,
    });

    const after = await search();
    expect(after.projects).toEqual([]);
  });

  it('answers an enabled product without asking', async () => {
    await project.products.enable(workspaceId, Products.ota, ada);

    expect(bodyOf(await call('mocco_products_enable', { product: Products.ota }))).toMatchObject({ changed: false });
  });

  it('refuses a handle the workspace already uses, through the service', async () => {
    await project.projects.create(workspaceId, { name: 'Taken', handle: 'taken' });

    const answer = await confirmed('mocco_projects_create', { name: 'Again', handle: 'taken' });

    expect(answer.result?.isError).toBe(true);
  });

  it('asks for the scope first, and refuses where the workspace does not allow agents to change things', async () => {
    const unscoped = await call('mocco_projects_create', { name: 'X', handle: 'x' }, { scopes: SIGN_IN });
    expect(unscoped.status).toBe(403);
    expect(unscoped.wwwAuthenticate).toContain('scope="projects:write openid profile email offline_access"');

    await settings.setAgentsMayDecide(workspaceId, false, ada);
    const answer = await call('mocco_projects_create', { name: 'X', handle: 'x' });
    expect(textOf(answer)).toContain('Agents may not set up projects');
  });

  it("adds nothing to another workspace's project", async () => {
    const theirs = expectOne(await t.db.insert(workspaces).values({ name: 'T', slug: randomUUID() }).returning()).id;
    const theirProject = await project.projects.create(theirs, { name: 'Theirs', handle: 'theirs' });

    const answer = await call('mocco_projects_apps_add', {
      projectId: theirProject.id,
      platform: AppPlatforms.web,
      name: 'Web',
    });

    expect(answer.result?.isError).toBe(true);
    expect(await project.projects.listApps(theirs, theirProject.id)).toEqual([]);
  });
});
