// `mocco_ota_*` over a real database, through the real HTTP handler.
//
// The reads are only as safe as the scoping in front of them, so many of these tests are
// about what a caller cannot see: a workspace they are not in reads the same whether it
// exists or not, an app or project of another workspace reads the same as one that does
// not exist, and a workspace without the OTA product says so.
import { randomUUID } from 'node:crypto';

import { AppPlatforms, Products } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { members, workspaces } from '@backend/infra/db/schema';
import { API, createOtaFixture, RUNTIME } from '@backend/transport/ext/v1/testing/ota-fixture';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { ProjectDomain } from '@backend/domain/project/instance';
import type { OtaFixture } from '@backend/transport/ext/v1/testing/ota-fixture';
import type { VersionPolicyRules } from '@mocco/common/ota';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const refuse = () => {
  throw new Error('the OTA tools must not reach another domain');
};

interface RpcAnswer {
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
  };
  error?: { code: number; message: string };
}

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

/** A successful answer's JSON; fails the test on a refusal, showing why. */
function bodyOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Record<string, unknown>;
}

type Row = Record<string, unknown>;

const rules = (overrides: Partial<VersionPolicyRules> = {}): VersionPolicyRules => ({
  minSupportedVersion: '2.0',
  recommendedVersion: '2.1',
  blockedVersions: ['2.0.1'],
  messages: { en: { title: 'Update available', body: 'Please update the app.', action: 'Update' } },
  storeUrl: 'https://apps.apple.com/app/id1',
  softPromptIntervalHours: 24,
  approvalPolicy: null,
  ...overrides,
});

describe('mocco_ota_* (pglite, over HTTP)', () => {
  let f: OtaFixture;
  let project: ProjectDomain;
  let handler: McpHttpHandler;
  let ada: string;
  let v1: { releaseId: string; updateId: string };
  let v2: { releaseId: string; updateId: string };
  let theirs: string;
  let theirProject: string;
  let theirOtaApp: string;
  let iosApp: string;
  let androidApp: string;

  async function rpc(userId: string, method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
    const name = typeof params.name === 'string' ? params.name : undefined;
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': method,
        ...(name !== undefined && { 'mcp-name': name }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope } }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: 'agent',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: userId },
      },
    });
    const text = await response.text();
    return (text === '' ? {} : JSON.parse(text)) as RpcAnswer;
  }

  const call = async (tool: string, args: Record<string, unknown>, userId = ada) =>
    await rpc(userId, 'tools/call', { name: tool, arguments: args });

  /** An update check from a device on the staging channel, reporting what it runs. */
  const check = async (clientId: string, currentUpdateId: string) =>
    await f.app.fetch(
      new Request(`${API}/ota/apps/${f.otaAppId}/manifest`, {
        headers: {
          'expo-protocol-version': '1',
          'expo-platform': 'ios',
          'expo-runtime-version': RUNTIME,
          'expo-channel-name': 'staging',
          'eas-client-id': clientId,
          'expo-current-update-id': currentUpdateId,
        },
      }),
    );

  beforeEach(async () => {
    f = await createOtaFixture();
    project = createProjectDomain(f.t.db);
    ada = f.ownerId;
    await f.t.db.insert(members).values({ organizationId: f.workspaceId, userId: ada, role: 'owner' });
    await project.products.enable(f.workspaceId, Products.ota, ada);

    // Staging serves v1 and rolls v2 out to a quarter; production is protected and empty.
    const staging = await f.ota.otaHosting.createChannel(f.appRow, ada, { name: 'staging', policy: null });
    await f.ota.otaHosting.createChannel(f.appRow, ada, {
      name: 'production',
      policy: { resume: [{ role: 'mobile-release', count: 1 }], prevent_self: true, reason_required: false },
    });
    v1 = await f.publishReady('v1');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v1.releaseId, ada, null);
    v2 = await f.publishReady('v2');
    await f.ota.otaChannels.promote(f.appRow, staging.id, v2.releaseId, ada, null, 2500);

    // Two store apps of the same project; only iOS has a policy.
    const ios = await project.projects.addApp(f.workspaceId, f.projectId, { platform: AppPlatforms.ios, name: 'iOS' });
    const android = await project.projects.addApp(f.workspaceId, f.projectId, {
      platform: AppPlatforms.android,
      name: 'Android',
    });
    iosApp = ios.id;
    androidApp = android.id;
    await f.ota.versionPolicies.change(f.workspaceId, f.projectId, iosApp, ada, {
      rules: rules(),
      reason: 'drop 1.x',
      storeLiveAttested: true,
    });

    // Another workspace, with its own hosted app and channel, that Ada is not in.
    theirs = expectOne(await f.t.db.insert(workspaces).values({ name: 'T', slug: randomUUID() }).returning()).id;
    await project.products.enable(theirs, Products.ota, ada);
    const rival = await project.projects.create(theirs, { name: 'Rival', handle: 'rival' });
    theirProject = rival.id;
    const theirApp = await project.projects.addApp(theirs, theirProject, {
      platform: AppPlatforms.reactNative,
      name: 'Rival mobile',
    });
    const theirHosted = await f.ota.otaHosting.createApp(theirs, theirProject, ada, theirApp.id);
    theirOtaApp = theirHosted.id;
    const theirRow = await f.ota.otaHosting.requireApp(theirs, theirProject, theirOtaApp);
    await f.ota.otaHosting.createChannel(theirRow, ada, { name: 'their-secret-channel', policy: null });

    const scope = new WorkspaceScope({ memberships: new MembershipRepo(f.t.db) });
    handler = createMcpHttpHandler({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals: { list: refuse, get: refuse, vote: refuse },
      gates: { getPending: refuse, resume: refuse },
      flags: { listFlags: refuse, listEnvironments: refuse, history: refuse },
      scope,
      projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
      otaHosting: f.ota.otaHosting,
      otaChannels: f.ota.otaChannels,
      otaReleases: f.ota.otaUploads,
      otaMetrics: f.ota.otaMetrics,
      versionPolicies: f.ota.versionPolicies,
      projectApps: project.projects,
      statusPages: { listPages: refuse, getPage: refuse },
      statusIncidents: { list: refuse, get: refuse },
      statusMaintenances: { list: refuse },
      settings: { agentsMayDecide: refuse },
      confirmations: undefined,
    });
  });
  afterEach(async () => {
    await f.close();
  });

  it('declares every OTA tool read-only', async () => {
    const listed = await rpc(ada, 'tools/list', {});

    const otaTools = listed.result?.tools?.filter(tool => tool.name.startsWith('mocco_ota_')) ?? [];
    expect(new Set(otaTools.map(tool => tool.name))).toEqual(
      new Set([
        'mocco_ota_adoption_get',
        'mocco_ota_channels_search',
        'mocco_ota_releases_search',
        'mocco_ota_version_policies_search',
      ]),
    );
    expect(otaTools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  describe('mocco_ota_channels_search', () => {
    it("says what each channel of the project's only hosted app serves, without being told which", async () => {
      const body = bodyOf(await call('mocco_ota_channels_search', {}));
      const channels = body.channels as { name: string; isProtected: boolean; heads: Row[] }[];

      expect(body.app).toEqual({ id: f.otaAppId, projectAppId: expect.any(String), name: 'Acme mobile' });
      expect(channels.map(channel => [channel.name, channel.isProtected])).toEqual(
        expect.arrayContaining([
          ['staging', false],
          ['production', true],
        ]),
      );
      expect(channels.find(channel => channel.name === 'production')?.heads).toEqual([]);
      expect(channels.find(channel => channel.name === 'staging')?.heads).toEqual([
        {
          platform: 'ios',
          runtimeVersion: RUNTIME,
          serving: `serves release ${v1.releaseId}; rolling out ${v2.releaseId} to 25%`,
          releaseId: v1.releaseId,
          candidateReleaseId: v2.releaseId,
          rolloutPercent: 25,
          isPaused: false,
        },
      ]);
    });

    it('keeps concise concise, and says more only when asked', async () => {
      const detailed = bodyOf(
        await call('mocco_ota_channels_search', { channel: 'production', responseFormat: 'detailed' }),
      );
      const staging = bodyOf(
        await call('mocco_ota_channels_search', { channel: 'staging', responseFormat: 'detailed' }),
      );

      expect(detailed.channels).toEqual([
        expect.objectContaining({
          name: 'production',
          id: expect.any(String),
          policy: expect.objectContaining({ prevent_self: true }),
        }),
      ]);
      expect((staging.channels as { heads: Row[] }[])[0]?.heads[0]).toMatchObject({
        isRolledBack: false,
        isServingEmbedded: false,
        canRollBackToEmbedded: true,
      });
    });

    it('takes the app by its project app id too, and says a channel it does not have was not found', async () => {
      const byProjectApp = bodyOf(
        await call('mocco_ota_channels_search', { appId: f.appRow.projectAppId, channel: 'staging' }),
      );
      const unknown = await call('mocco_ota_channels_search', { channel: 'their-secret-channel' });

      expect(byProjectApp.channels).toHaveLength(1);
      expect(unknown.result?.isError).toBe(true);
      expect(textOf(unknown)).toContain('their-secret-channel was not found');
    });

    it("refuses another workspace's app exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const foreign = await call('mocco_ota_channels_search', { appId: theirOtaApp });
      const missing = await call('mocco_ota_channels_search', { appId: nowhere });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('was not found');
      expect(textOf(foreign).replace(theirOtaApp, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(foreign)).not.toContain('their-secret-channel');
    });

    it('names the hosted apps to choose from when the project has more than one', async () => {
      const second = await project.projects.addApp(f.workspaceId, f.projectId, {
        platform: AppPlatforms.reactNative,
        name: 'Acme kiosk',
      });
      const hosted = await f.ota.otaHosting.createApp(f.workspaceId, f.projectId, ada, second.id);

      const answer = await call('mocco_ota_channels_search', {});

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain(`Acme kiosk (${hosted.id})`);
      expect(textOf(answer)).toContain(`Acme mobile (${f.otaAppId})`);
    });
  });

  describe('mocco_ota_releases_search', () => {
    it('finds releases newest first, concise unless asked', async () => {
      const concise = bodyOf(await call('mocco_ota_releases_search', {}));
      const detailed = bodyOf(await call('mocco_ota_releases_search', { responseFormat: 'detailed', limit: 1 }));

      expect((concise.releases as Row[]).map(release => release.id)).toEqual([v2.releaseId, v1.releaseId]);
      expect((concise.releases as Row[])[0]).toEqual({
        id: v2.releaseId,
        runtimeVersion: RUNTIME,
        status: 'ready',
        message: 'Fix the login button',
        gitSha: 'abc1234',
        createdAt: expect.any(String),
      });
      expect((detailed.releases as Row[])[0]).toMatchObject({ platforms: ['ios'], isMandatory: false });
    });

    it('filters by message or commit, runtime version, state and platform', async () => {
      const unverified = await f.publish();

      const byMessage = bodyOf(await call('mocco_ota_releases_search', { query: 'LOGIN' }));
      const byCommit = bodyOf(await call('mocco_ota_releases_search', { query: 'abc12' }));
      const nothing = bodyOf(await call('mocco_ota_releases_search', { query: 'checkout' }));
      const otherRuntime = bodyOf(await call('mocco_ota_releases_search', { runtimeVersion: '9.9.9' }));
      const notReady = bodyOf(await call('mocco_ota_releases_search', { status: 'verifying' }));
      const android = bodyOf(await call('mocco_ota_releases_search', { platform: 'android' }));

      expect(byMessage.releases).toHaveLength(3);
      expect(byCommit.releases).toHaveLength(3);
      expect(nothing.releases).toEqual([]);
      expect(otherRuntime.releases).toEqual([]);
      expect((notReady.releases as Row[]).map(release => release.id)).toEqual([unverified.releaseId]);
      expect(android.releases).toEqual([]);
    });

    it('pages newest first, and says where the next page starts only when there is one', async () => {
      const first = bodyOf(await call('mocco_ota_releases_search', { limit: 1 }));
      const second = bodyOf(await call('mocco_ota_releases_search', { limit: 1, before: first.nextBefore }));

      expect((first.releases as Row[]).map(release => release.id)).toEqual([v2.releaseId]);
      expect(first.nextBefore).toEqual(expect.any(String));
      expect((second.releases as Row[]).map(release => release.id)).toEqual([v1.releaseId]);
      expect(second).not.toHaveProperty('nextBefore');
    });
  });

  describe('mocco_ota_adoption_get', () => {
    it('counts devices per channel and release, and splits them by platform when asked', async () => {
      await check('device-a', v1.updateId);
      await check('device-b', v1.updateId);
      await check('device-c', v2.updateId);
      await f.ota.otaMetrics.flush();

      const concise = bodyOf(await call('mocco_ota_adoption_get', {}));
      const detailed = bodyOf(await call('mocco_ota_adoption_get', { responseFormat: 'detailed' }));
      const elsewhere = bodyOf(await call('mocco_ota_adoption_get', { channel: 'production' }));

      expect(concise).toMatchObject({ monthlyActiveDevices: 3, devicesLast24h: 3 });
      expect(concise.reach).toEqual([
        { channel: 'staging', releaseId: v1.releaseId, devices: 2 },
        { channel: 'staging', releaseId: v2.releaseId, devices: 1 },
      ]);
      expect((detailed.reach as Row[])[0]).toEqual({
        channel: 'staging',
        platform: 'ios',
        runtimeVersion: RUNTIME,
        releaseId: v1.releaseId,
        devices: 2,
      });
      expect(elsewhere).toMatchObject({ devicesLast24h: 0, reach: [] });
    });
  });

  describe('mocco_ota_version_policies_search', () => {
    it("reads every store app's policy, and points at where a gated change waits", async () => {
      const body = bodyOf(await call('mocco_ota_version_policies_search', {}));
      const apps = body.apps as Row[];

      expect(apps).toHaveLength(2);
      expect(apps).toEqual(
        expect.arrayContaining([
          { appId: androidApp, name: 'Android', platform: 'android', policy: null },
          {
            appId: iosApp,
            name: 'iOS',
            platform: 'ios',
            policy: {
              minSupportedVersion: '2.0',
              recommendedVersion: '2.1',
              blockedVersions: ['2.0.1'],
              isGated: false,
              revision: 1,
              updatedAt: expect.any(String),
            },
          },
        ]),
      );
      expect(body.pendingChanges).toContain('ota.version_policy');
    });

    it('adds the messages and the latest changes when asked', async () => {
      const body = bodyOf(
        await call('mocco_ota_version_policies_search', { appId: iosApp, responseFormat: 'detailed' }),
      );

      expect(body.apps).toEqual([
        expect.objectContaining({
          appId: iosApp,
          policy: expect.objectContaining({ storeUrl: 'https://apps.apple.com/app/id1', softPromptIntervalHours: 24 }),
          recentChanges: [expect.objectContaining({ reason: 'drop 1.x', approvalRequestId: null })],
        }),
      ]);
    });

    it('refuses an app that has no store, and one of another workspace as one that does not exist', async () => {
      const nowhere = randomUUID();
      const theirApps = await project.projects.listApps(theirs, theirProject);
      const theirAppId = theirApps[0]?.id ?? '';

      const reactNative = await call('mocco_ota_version_policies_search', { appId: f.appRow.projectAppId });
      const foreign = await call('mocco_ota_version_policies_search', { appId: theirAppId });
      const missing = await call('mocco_ota_version_policies_search', { appId: nowhere });

      expect(textOf(reactNative)).toContain('store apps only');
      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('was not found');
      expect(textOf(foreign).replace(theirAppId, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
    });
  });

  it('refuses a workspace the caller is not in exactly as one that does not exist', async () => {
    const nowhere = randomUUID();

    const existing = await call('mocco_ota_channels_search', { workspaceId: theirs, projectId: theirProject });
    const missing = await call('mocco_ota_channels_search', { workspaceId: nowhere, projectId: randomUUID() });

    expect(existing.result?.isError).toBe(true);
    expect(textOf(existing)).toContain('No workspace');
    expect(textOf(existing).replace(theirs, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
    expect(textOf(existing)).not.toContain('their-secret-channel');
  });

  it("refuses another workspace's project exactly as one that does not exist", async () => {
    const nowhere = randomUUID();

    const foreign = await call('mocco_ota_releases_search', { projectId: theirProject });
    const missing = await call('mocco_ota_releases_search', { projectId: nowhere });

    expect(foreign.result?.isError).toBe(true);
    expect(textOf(foreign)).toContain('was not found');
    expect(textOf(foreign).replace(theirProject, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
  });

  it('refuses where the OTA product is off, as the console does', async () => {
    await project.products.disable(f.workspaceId, Products.ota);

    const answers = await Promise.all(
      [
        'mocco_ota_channels_search',
        'mocco_ota_releases_search',
        'mocco_ota_adoption_get',
        'mocco_ota_version_policies_search',
      ].map(async tool => await call(tool, {})),
    );

    expect(answers.map(answer => answer.result?.isError)).toEqual([true, true, true, true]);
    expect(answers.every(answer => textOf(answer).includes('not enabled'))).toBe(true);
  });
});
