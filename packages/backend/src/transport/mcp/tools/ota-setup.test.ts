// `mocco_ota_setup_get` and the OTA setup changes over a real database, through the real
// HTTP handler.
//
// The changes are only as safe as the locks in front of them, so most of these tests are
// about what does not happen: no change without `ota:write`, the workspace's opt-in and a
// confirmed round trip; no certificate or trust policy from a plain member; no private key
// accepted as a certificate; and nothing in another workspace.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { AppPlatforms, Products } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { TEST_SIGNING_CERT_PEM, TEST_SIGNING_KEY_PEM } from '@backend/domain/ota/testing/signing-fixtures';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { members, users, workspaces } from '@backend/infra/db/schema';
import { createOtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { ProjectDomain } from '@backend/domain/project/instance';
import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  // The changes confirm through a form elicitation.
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the OTA setup tools must not reach another domain');
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
  error?: { code: number; message: string };
}

interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });

const messageOf = (answer: RpcAnswer) => answer.result?.inputRequests?.confirm?.params.message ?? '';

const SIGN_IN = ['openid', 'profile', 'email', 'offline_access'];
const WITH_OTA_WRITE = [...SIGN_IN, 'ota:write'];

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

function bodyOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Record<string, unknown>;
}

type Row = Record<string, unknown>;

const appNamed = (body: Record<string, unknown>, name: string) =>
  (body.apps as Row[]).find(each => each.name === name) as Row;

describe('mocco_ota_setup_get and the OTA setup changes (pglite, over HTTP)', () => {
  let f: OtaFixture;
  let project: ProjectDomain;
  let handler: McpHttpHandler;
  let settings: McpSettingsService;
  let audit: AuditService;
  let ada: string;
  let bob: string;
  let lite: string;

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
        scopes: options.scopes ?? WITH_OTA_WRITE,
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

  /** The first round, which must ask; returns the answer and the state to echo. */
  async function ask(tool: string, args: Record<string, unknown>, userId = ada) {
    const asked = await call(tool, args, { userId });
    expect(asked.result?.resultType, textOf(asked)).toBe('input_required');
    return { asked, requestState: asked.result?.requestState ?? '' };
  }

  /** Ask, then answer: the whole round trip. */
  async function confirmed(tool: string, args: Record<string, unknown>, isConfirmed = true, userId = ada) {
    const { requestState } = await ask(tool, args, userId);
    return await call(tool, args, { userId, round: { requestState, inputResponses: accepting(isConfirmed) } });
  }

  const actorsOf = async (action: string) => {
    const entries = await audit.list(f.workspaceId, 0n);
    return entries.filter(entry => entry.action === action).map(entry => entry.actorUserId);
  };

  const setupOf = async () => bodyOf(await call('mocco_ota_setup_get', {}, { scopes: SIGN_IN }));

  beforeEach(async () => {
    f = await createOtaFixture();
    project = createProjectDomain(f.t.db);
    ada = f.ownerId;
    await f.t.db.insert(members).values({ organizationId: f.workspaceId, userId: ada, role: 'owner' });
    bob = expectOne(
      await f.t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Bob', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    await f.t.db.insert(members).values({ organizationId: f.workspaceId, userId: bob, role: 'member' });
    await project.products.enable(f.workspaceId, Products.ota, ada);
    // A second React Native app, not hosted yet, and a web app that can never be.
    const liteProjectApp = await project.projects.addApp(f.workspaceId, f.projectId, {
      platform: AppPlatforms.reactNative,
      name: 'Acme lite',
    });
    lite = liteProjectApp.id;
    await project.projects.addApp(f.workspaceId, f.projectId, { platform: AppPlatforms.web, name: 'Acme web' });

    audit = new AuditService({ audit: new AuditRepo(f.t.db) });
    settings = createMcpSettingsService(f.t.db, audit);
    await settings.setAgentsMayDecide(f.workspaceId, true, ada);

    const scope = new WorkspaceScope({ memberships: new MembershipRepo(f.t.db) });
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
      otaSetup: { hosting: f.ota.otaHosting, signing: f.ota.otaSigning, trustPolicies: f.ota.otaTrustPolicies },
      projectApps: project.projects,
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
      feedbackLinks: {
        repos: refuse,
        search: refuse,
        list: refuse,
        preview: refuse,
        requireLink: refuse,
        link: refuse,
        unlink: refuse,
      },
      settings,
      confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
    });
  });
  afterEach(async () => {
    await f.close();
  });

  describe('mocco_ota_setup_get', () => {
    it("lists the project's React Native apps, hosted or not, with what each still needs", async () => {
      const body = await setupOf();

      expect(new Set((body.apps as Row[]).map(each => each.name))).toEqual(new Set(['Acme lite', 'Acme mobile']));
      expect(appNamed(body, 'Acme lite')).toMatchObject({ projectAppId: lite, isHosted: false });
      const mobile = appNamed(body, 'Acme mobile');
      expect(mobile).toMatchObject({
        isHosted: true,
        appId: f.otaAppId,
        manifestUrl: expect.stringContaining(f.otaAppId),
        updates: {
          url: mobile.manifestUrl,
          codeSigningCertificate: './certs/certificate.pem',
          codeSigningMetadata: { keyid: 'root', alg: 'rsa-v1_5-sha256' },
        },
        channels: [],
        certificates: [expect.objectContaining({ keyid: 'root', status: 'active' })],
        trustPolicies: [],
      });
      // The fixture's app has its certificate; a channel and a trusted repository are missing.
      expect(mobile.next).toEqual([
        expect.stringContaining('mocco_ota_channels_create'),
        expect.stringContaining('mocco_ota_trust_policies_create'),
      ]);
    });

    it('needs no write scope and changes nothing', async () => {
      await setupOf();

      expect(await actorsOf(AuditActions.otaAppCreated)).toEqual([ada]);
    });
  });

  describe('mocco_ota_apps_host', () => {
    it('hosts the one React Native app not hosted yet, after the person confirms, as them', async () => {
      const { asked } = await ask('mocco_ota_apps_host', {});
      expect(messageOf(asked)).toContain(`Acme lite (${lite})`);

      const done = bodyOf(
        await call(
          'mocco_ota_apps_host',
          {},
          { round: { requestState: asked.result?.requestState, inputResponses: accepting(true) } },
        ),
      );

      expect(done).toMatchObject({ changed: true, manifestUrl: expect.stringContaining(String(done.appId)) });
      expect(appNamed(await setupOf(), 'Acme lite')).toMatchObject({ isHosted: true, appId: done.appId });
      expect(await actorsOf(AuditActions.otaAppCreated)).toEqual([ada, ada]);
    });

    it('changes nothing when the person says no', async () => {
      const answer = bodyOf(await confirmed('mocco_ota_apps_host', {}, false));

      expect(answer).toMatchObject({ changed: false });
      expect(appNamed(await setupOf(), 'Acme lite')).toMatchObject({ isHosted: false });
    });

    it('refuses a web app through the service, as the console does', async () => {
      const apps = await project.projects.listApps(f.workspaceId, f.projectId);
      const web = apps.find(each => each.platform === AppPlatforms.web)?.id;

      const answer = await confirmed('mocco_ota_apps_host', { projectAppId: web });

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toMatch(/react native/iu);
    });

    it('asks for the scope first, and refuses where the workspace does not allow agents to change things', async () => {
      const unscoped = await call('mocco_ota_apps_host', {}, { scopes: SIGN_IN });
      expect(unscoped.status).toBe(403);
      expect(unscoped.wwwAuthenticate).toContain('scope="ota:write openid profile email offline_access"');

      await settings.setAgentsMayDecide(f.workspaceId, false, ada);
      const answer = await call('mocco_ota_apps_host', {});
      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain('Agents may not set up OTA hosting');
    });
  });

  describe('mocco_ota_channels_create', () => {
    it('adds an open channel to the hosted app', async () => {
      const done = bodyOf(await confirmed('mocco_ota_channels_create', { appId: f.otaAppId, name: 'staging' }));

      expect(done).toMatchObject({ changed: true, channel: { name: 'staging', isProtected: false } });
      expect((appNamed(await setupOf(), 'Acme mobile').channels as Row[]).map(each => each.name)).toEqual(['staging']);
      expect(await actorsOf(AuditActions.otaChannelCreated)).toEqual([ada]);
    });

    it('lets a plain member add one, as the console does', async () => {
      const done = bodyOf(await confirmed('mocco_ota_channels_create', { appId: f.otaAppId, name: 'beta' }, true, bob));

      expect(done).toMatchObject({ changed: true });
    });

    it('needs the app named when the project hosts more than one', async () => {
      await f.ota.otaHosting.createApp(f.workspaceId, f.projectId, ada, lite);

      const answer = await call('mocco_ota_channels_create', { name: 'staging' });

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain('Say which app with appId');
    });
  });

  describe('mocco_ota_certificates_add', () => {
    let liteApp: string;
    beforeEach(async () => {
      const hosted = await f.ota.otaHosting.createApp(f.workspaceId, f.projectId, ada, lite);
      liteApp = hosted.id;
    });

    it('registers the certificate the app embeds, as the owner', async () => {
      const done = bodyOf(
        await confirmed('mocco_ota_certificates_add', { appId: liteApp, certificatePem: TEST_SIGNING_CERT_PEM }),
      );

      expect(done).toMatchObject({ changed: true, certificate: { keyid: 'root', status: 'active' } });
      expect(await actorsOf(AuditActions.otaCertAdded)).toEqual([ada, ada]);
    });

    it('refuses a private key before asking anything', async () => {
      const answer = await call('mocco_ota_certificates_add', { appId: liteApp, certificatePem: TEST_SIGNING_KEY_PEM });

      expect(answer.result?.resultType).not.toBe('input_required');
      expect(textOf(answer)).toContain('That is a private key');
    });

    it('refuses a plain member before asking anything', async () => {
      const answer = await call(
        'mocco_ota_certificates_add',
        { appId: liteApp, certificatePem: TEST_SIGNING_CERT_PEM },
        { userId: bob },
      );

      expect(answer.result?.resultType).not.toBe('input_required');
      expect(textOf(answer)).toContain('Only an owner or admin');
    });
  });

  describe('mocco_ota_trust_policies_create', () => {
    const trust = {
      repositoryId: '123456',
      repository: 'acme/mobile',
      refPattern: 'refs/heads/main',
      workflowRef: 'acme/mobile/.github/workflows/ota.yml@refs/heads/main',
      environment: null,
      allowedChannels: ['staging'],
    };

    beforeEach(async () => {
      await f.ota.otaHosting.createChannel(f.appRow, ada, { name: 'staging', policy: null });
    });

    it('trusts the repository to publish, showing exactly what it may do', async () => {
      const { asked, requestState } = await ask('mocco_ota_trust_policies_create', { appId: f.otaAppId, ...trust });
      expect(messageOf(asked)).toContain('Repository: acme/mobile (id 123456)');
      expect(messageOf(asked)).toContain('May promote to: staging');

      const done = bodyOf(
        await call(
          'mocco_ota_trust_policies_create',
          { appId: f.otaAppId, ...trust },
          {
            round: { requestState, inputResponses: accepting(true) },
          },
        ),
      );

      expect(done).toMatchObject({
        changed: true,
        trustPolicy: { repository: 'acme/mobile', allowedChannels: ['staging'] },
      });
      expect(appNamed(await setupOf(), 'Acme mobile').next).toEqual([]);
      expect(await actorsOf(AuditActions.otaTrustPolicyCreated)).toEqual([ada]);
    });

    it('refuses a confirmation shown for a different policy', async () => {
      const { requestState } = await ask('mocco_ota_trust_policies_create', { appId: f.otaAppId, ...trust });

      const answer = await call(
        'mocco_ota_trust_policies_create',
        { appId: f.otaAppId, ...trust, refPattern: 'refs/heads/*' },
        { round: { requestState, inputResponses: accepting(true) } },
      );

      expect(textOf(answer)).toContain('That confirmation was for a different change');
      expect(await actorsOf(AuditActions.otaTrustPolicyCreated)).toEqual([]);
    });

    it('refuses a plain member', async () => {
      const answer = await call('mocco_ota_trust_policies_create', { appId: f.otaAppId, ...trust }, { userId: bob });

      expect(textOf(answer)).toContain('Only an owner or admin');
    });
  });

  it("reads another workspace's project exactly like one that does not exist", async () => {
    const theirs = expectOne(
      await f.t.db.insert(workspaces).values({ name: 'Them', slug: randomUUID() }).returning(),
    ).id;
    const theirProject = await project.projects.create(theirs, { name: 'Theirs', handle: 'theirs' });

    const answer = await call('mocco_ota_setup_get', { projectId: theirProject.id }, { scopes: SIGN_IN });

    expect(answer.result?.isError).toBe(true);
  });
});
