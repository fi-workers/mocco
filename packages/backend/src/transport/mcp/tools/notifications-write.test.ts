// The tools that change notification settings, over a real database, through the real
// HTTP handler, with a scripted Discord.
//
// Like the vote's and the resume's tests, these send what a client sends: the scope
// challenge, the signed confirmation state and the SDK seam that verifies it are part of
// what is being proven. Most of the tests are about what does not happen: nothing changes
// before the person says yes, and nothing changes for a person the console would refuse.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ChannelStatuses } from '@mocco/common/notification';
import { rulePresetRules } from '@mocco/common/notification-presets';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { RuleRepo } from '@backend/domain/notification/repos/rule.repo';
import {
  botInGuild,
  createTestChannelService,
  guildChannelsReply,
  messageCreated,
  seedGuild,
} from '@backend/domain/notification/testing/channel-service';
import { seedWorkspace } from '@backend/domain/notification/testing/seed';
import { expectOne } from '@backend/infra/db/rows';
import { members, notificationChannels, users } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { NotificationWriteTools } from '@backend/transport/mcp/tools/notifications-write';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { DiscordGuildRow } from '@backend/domain/notification/repos/discord-guild.repo';
import type { FakeReply } from '@backend/domain/notification/testing/fake-discord-fetch';
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
  throw new Error('the notification tools must not reach another domain');
};

const ALERTS = { id: '700000000000000001', name: 'alerts' };
const DEPLOYS = { id: '700000000000000002', name: 'deploys' };

/** Values that must never appear in any answer. */
const CHANNEL_SECRET = 'sealed-channel-secret-do-not-leak';
const BOT_TOKEN = 'bot-token-secret';

const CHANGING_TOOLS = [
  NotificationWriteTools.connect,
  NotificationWriteTools.reenable,
  NotificationWriteTools.addRule,
  NotificationWriteTools.removeRule,
  NotificationWriteTools.applyPreset,
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

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';
const messageOf = (answer: RpcAnswer) => answer.result?.inputRequests?.confirm?.params.message ?? '';

/** The person's answer to the confirmation, as a client sends it back. */
const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });

describe('mocco_notifications_* changes (pglite, over HTTP)', () => {
  let t: TestDb;
  let audit: AuditService;
  let settings: McpSettingsService;
  let scope: WorkspaceScope;
  let handler: McpHttpHandler;
  let workspaceId: string;
  let guild: DiscordGuildRow;
  let ada: string;
  let bob: string;
  let carol: string;
  /** Every answer any test got, checked for secrets at the end of each test. */
  let answers: RpcAnswer[];

  const deps = (notifications: McpToolDeps['notifications']): McpToolDeps => ({
    runs: { searchInWorkspace: refuse, get: refuse },
    approvals: { list: refuse, get: refuse, vote: refuse },
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
    notifications,
    notificationActivity: { list: refuse },
    inbound: undefined,
    scope,
    projects: { resolve: refuse, resolveWorkspace: refuse },
    settings,
    confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
  });

  /** The handler over a ChannelService whose Discord answers `script` in order. */
  function serve(...script: FakeReply[]) {
    handler = createMcpHttpHandler(deps(createTestChannelService(t.db, ...script).service));
  }

  async function rpc(caller: Caller, method: string, params: Record<string, unknown>, round: Round = {}) {
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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope, ...round } }),
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
    const answer = { status: response.status, wwwAuthenticate: response.headers.get('www-authenticate'), ...body };
    answers.push(answer);
    return answer;
  }

  const call = async (tool: string, args: Record<string, unknown>, round: Round = {}, caller?: Caller) =>
    await rpc(caller ?? { userId: ada }, 'tools/call', { name: tool, arguments: args }, round);

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
    return JSON.parse(textOf(answer)) as Record<string, unknown>;
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

  const rulesOf = async () => await new RuleRepo(t.db).findByWorkspace(workspaceId);
  const channelsOf = async () => await new ChannelRepo(t.db).findByWorkspace(workspaceId);
  const channelNames = async () => {
    const channels = await channelsOf();
    return channels.map(channel => channel.name);
  };
  const auditActions = async () => {
    const entries = await audit.list(workspaceId, 0n);
    return entries
      .filter(entry => entry.action.startsWith('notification.'))
      .map(entry => [entry.action, entry.actorUserId]);
  };
  /** Who made each change of one kind. */
  const actorsOf = async (action: string) => {
    const entries = await auditActions();
    return entries.filter(([each]) => each === action).map(([, actor]) => actor);
  };

  /** A connected #alerts channel, made through the console's service as Ada. */
  async function connectedAlerts() {
    const { service } = createTestChannelService(t.db, ...botInGuild(), guildChannelsReply(ALERTS), messageCreated());
    const { channel } = await service.createChannel(workspaceId, ada, { guildId: guild.id, channelId: ALERTS.id });
    // As a customer bot token would be stored.
    await t.db
      .update(notificationChannels)
      .set({ secretSealed: CHANNEL_SECRET })
      .where(eq(notificationChannels.id, channel.id));
    return channel;
  }

  beforeEach(async () => {
    t = await createTestDb();
    answers = [];
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    settings = createMcpSettingsService(t.db, audit);
    scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    workspaceId = await seedWorkspace(t.db, 'Acme');
    ada = await addUser('owner');
    bob = await addUser('member');
    carol = await addUser('member,admin');
    guild = await seedGuild(t.db, workspaceId, undefined, ada);
    await settings.setAgentsMayDecide(workspaceId, true, ada);
    serve();
  });
  afterEach(async () => {
    const everything = answers.map(answer => JSON.stringify(answer)).join('\n');
    expect(everything).not.toContain(CHANNEL_SECRET);
    expect(everything).not.toContain(BOT_TOKEN);
    expect(everything).not.toMatch(/secretSealed|secret_sealed|externalId/u);
    await t.close();
  });

  it('declares the changing tools as such, and the Discord channel list read-only', async () => {
    const listed = await rpc({ userId: ada }, 'tools/list', {});
    const tools = listed.result?.tools ?? [];
    const annotationsOf = (name: string) => tools.find(tool => tool.name === name)?.annotations;

    expect(CHANGING_TOOLS.map(name => annotationsOf(name)?.readOnlyHint)).toEqual([false, false, false, false, false]);
    expect(annotationsOf(NotificationWriteTools.removeRule)?.destructiveHint).toBe(true);
    expect(annotationsOf(NotificationWriteTools.discordChannels)?.readOnlyHint).toBe(true);
  });

  describe('the locks in front of every change', () => {
    it('challenges a token without approvals:write for it, keeping the scopes it has', async () => {
      const channel = await connectedAlerts();

      const answer = await call(
        NotificationWriteTools.addRule,
        { channelId: channel.id, eventType: 'gate.*' },
        {},
        { userId: ada, scopes: SIGN_IN },
      );

      expect(answer.status).toBe(403);
      expect(answer.wwwAuthenticate).toContain('error="insufficient_scope"');
      expect(answer.wwwAuthenticate).toContain('scope="approvals:write openid profile email offline_access"');
      expect(await rulesOf()).toEqual([]);
    });

    it('refuses in a workspace that has not allowed agents to make changes, and says where to change it', async () => {
      const channel = await connectedAlerts();
      await settings.setAgentsMayDecide(workspaceId, false, ada);

      const answer = await call(NotificationWriteTools.addRule, { channelId: channel.id, eventType: 'gate.*' });

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain('Agents may not change notification settings in this workspace');
      expect(textOf(answer)).toContain('Settings → Agents');
      expect(await rulesOf()).toEqual([]);
    });

    it('refuses a plain member before asking anything, as the console does', async () => {
      const channel = await connectedAlerts();
      const asBob = { userId: bob };

      const changes = await Promise.all([
        call(NotificationWriteTools.addRule, { channelId: channel.id, eventType: 'gate.*' }, {}, asBob),
        call(NotificationWriteTools.applyPreset, { channelId: channel.id, preset: 'mocco' }, {}, asBob),
        call(NotificationWriteTools.reenable, { channelId: channel.id }, {}, asBob),
        call(NotificationWriteTools.connect, { discordChannelId: DEPLOYS.id }, {}, asBob),
        call(NotificationWriteTools.discordChannels, {}, {}, asBob),
      ]);

      expect(changes.map(answer => answer.result?.isError)).toEqual([true, true, true, true, true]);
      expect(changes.every(answer => textOf(answer).includes('Only an owner or admin'))).toBe(true);
      expect(changes.some(answer => answer.result?.resultType === 'input_required')).toBe(false);
      expect(await rulesOf()).toEqual([]);
    });

    it('lets an admin whose roles are stored comma-joined through, like the console', async () => {
      const channel = await connectedAlerts();

      const answer = await confirmed(
        NotificationWriteTools.addRule,
        { channelId: channel.id, eventType: 'gate.*' },
        { userId: carol },
      );

      expect(bodyOf(answer)).toMatchObject({ changed: true });
      expect(await auditActions()).toContainEqual([AuditActions.notificationRuleAdded, carol]);
    });

    it('refuses a workspace the caller is not in exactly as one that does not exist', async () => {
      const theirs = await seedWorkspace(t.db, 'Globex');
      await addUser('owner', theirs);
      const nowhere = randomUUID();

      const foreign = await call(NotificationWriteTools.addRule, {
        workspaceId: theirs,
        channelId: randomUUID(),
        eventType: 'gate.*',
      });
      const missing = await call(NotificationWriteTools.addRule, {
        workspaceId: nowhere,
        channelId: randomUUID(),
        eventType: 'gate.*',
      });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('No workspace');
      expect(textOf(foreign).replace(theirs, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
    });

    it('says so when this server does not compose notifications', async () => {
      handler = createMcpHttpHandler(deps(undefined));

      const answer = await call(NotificationWriteTools.addRule, { channelId: randomUUID(), eventType: 'gate.*' });

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain('Notifications are not available on this Mocco server');
    });
  });

  describe('the confirmation', () => {
    it('asks first, showing exactly what would change, and changes nothing', async () => {
      const channel = await connectedAlerts();
      const sourceId = randomUUID();

      const answer = await call(NotificationWriteTools.addRule, {
        channelId: channel.id,
        eventType: 'vercel.deployment.succeeded',
        sourceId,
        filter: { target: 'production' },
      });

      expect(answer.result?.resultType).toBe('input_required');
      expect(answer.result?.inputRequests?.confirm?.method).toBe('elicitation/create');
      expect(messageOf(answer)).toBe(
        [
          'Add a notification rule, as you?',
          'Send: vercel.deployment.succeeded events',
          `From source: ${sourceId}`,
          'Only when: target = "production"',
          `To channel: #alerts (${channel.id})`,
        ].join('\n'),
      );
      expect(await rulesOf()).toEqual([]);
      expect(await auditActions()).toEqual([[AuditActions.notificationChannelConnected, ada]]);
    });

    it('applies once confirmed, as the caller, and the audit names them', async () => {
      const channel = await connectedAlerts();

      const answer = await confirmed(NotificationWriteTools.addRule, {
        channelId: channel.id,
        eventType: 'gate.pending',
        filter: { gate: 'production' },
      });

      expect(bodyOf(answer)).toEqual({
        changed: true,
        rule: {
          id: expect.any(String),
          channelId: channel.id,
          eventType: 'gate.pending',
          sourceId: null,
          filter: { gate: 'production' },
        },
      });
      const rules = await rulesOf();
      expect(rules.map(rule => rule.eventType)).toEqual(['gate.pending']);
      expect(await auditActions()).toEqual([
        [AuditActions.notificationChannelConnected, ada],
        [AuditActions.notificationRuleAdded, ada],
      ]);
    });

    it('applies a confirmation once: replaying it does not add the rule twice', async () => {
      const channel = await connectedAlerts();
      const args = { channelId: channel.id, eventType: 'gate.pending' };
      const requestState = await ask(NotificationWriteTools.addRule, args);

      const first = await call(NotificationWriteTools.addRule, args, { requestState, inputResponses: accepting(true) });
      const replay = await call(NotificationWriteTools.addRule, args, {
        requestState,
        inputResponses: accepting(true),
      });

      expect(bodyOf(first)).toMatchObject({ changed: true });
      expect(replay.result?.isError).toBe(true);
      expect(textOf(replay)).toContain('already');
      expect(await rulesOf()).toHaveLength(1);
      expect(await actorsOf(AuditActions.notificationRuleAdded)).toEqual([ada]);
    });

    it('changes nothing when the person declines, cancels or answers no', async () => {
      const channel = await connectedAlerts();
      const args = { channelId: channel.id, eventType: 'gate.*' };

      const replies = await Promise.all(
        [{ confirm: { action: 'decline' } }, { confirm: { action: 'cancel' } }, accepting(false)].map(
          async inputResponses => {
            const requestState = await ask(NotificationWriteTools.addRule, args);
            return await call(NotificationWriteTools.addRule, args, { requestState, inputResponses });
          },
        ),
      );

      expect(replies.map(answer => bodyOf(answer))).toEqual([
        expect.objectContaining({ changed: false }),
        expect.objectContaining({ changed: false }),
        expect.objectContaining({ changed: false }),
      ]);
      expect(await rulesOf()).toEqual([]);
    });

    it('refuses a state that was tampered with', async () => {
      const channel = await connectedAlerts();
      const args = { channelId: channel.id, eventType: 'gate.*' };
      const requestState = await ask(NotificationWriteTools.addRule, args);
      const [version, body = '', mac] = requestState.split('.');
      const forged = [version, `${body.slice(0, -2)}AA`, mac].join('.');

      const answer = await call(NotificationWriteTools.addRule, args, {
        requestState: forged,
        inputResponses: accepting(true),
      });

      expect(answer.error?.code).toBe(-32_602);
      expect(await rulesOf()).toEqual([]);
    });

    it('refuses a state minted for someone else, or for another app of the same person', async () => {
      const channel = await connectedAlerts();
      const args = { channelId: channel.id, eventType: 'gate.*' };
      const requestState = await ask(NotificationWriteTools.addRule, args, { userId: carol });

      const asAda = await call(NotificationWriteTools.addRule, args, { requestState, inputResponses: accepting(true) });
      const fromAnotherApp = await call(
        NotificationWriteTools.addRule,
        args,
        { requestState, inputResponses: accepting(true) },
        { userId: carol, clientId: 'other-agent' },
      );

      expect(asAda.error?.code).toBe(-32_602);
      expect(fromAnotherApp.error?.code).toBe(-32_602);
      expect(await rulesOf()).toEqual([]);
    });

    it("refuses one tool's confirmation carried into another, or into another change of the same tool", async () => {
      const channel = await connectedAlerts();
      const requestState = await ask(NotificationWriteTools.applyPreset, { channelId: channel.id, preset: 'mocco' });

      const otherTool = await call(
        NotificationWriteTools.addRule,
        { channelId: channel.id, eventType: 'gate.*' },
        { requestState, inputResponses: accepting(true) },
      );
      const otherPreset = await call(
        NotificationWriteTools.applyPreset,
        { channelId: channel.id, preset: 'github' },
        { requestState, inputResponses: accepting(true) },
      );

      expect([otherTool, otherPreset].map(answer => answer.result?.isError)).toEqual([true, true]);
      expect(textOf(otherTool)).toContain('different change');
      expect(textOf(otherPreset)).toContain('different change');
      expect(await rulesOf()).toEqual([]);
    });
  });

  describe('each change', () => {
    it('removes a rule, naming it in the confirmation', async () => {
      const channel = await connectedAlerts();
      const { service } = createTestChannelService(t.db);
      const rule = await service.addRule(workspaceId, ada, channel.id, {
        eventType: 'run.failed',
        sourceId: null,
        filter: { repo: 'acme/web' },
      });

      const asked = await call(NotificationWriteTools.removeRule, { ruleId: rule.id });
      const done = await confirmed(NotificationWriteTools.removeRule, { ruleId: rule.id });
      const again = await call(NotificationWriteTools.removeRule, { ruleId: rule.id });

      expect(messageOf(asked)).toContain('Stops sending: run.failed events');
      expect(messageOf(asked)).toContain('Only when: repo = "acme/web"');
      expect(bodyOf(done)).toEqual({ changed: true, removedRuleId: rule.id });
      expect(await rulesOf()).toEqual([]);
      expect(again.result?.isError).toBe(true);
      expect(textOf(again)).toContain('not found');
      expect(await auditActions()).toContainEqual([AuditActions.notificationRuleRemoved, ada]);
    });

    it('applies a preset, listing its rules, and a second time adds nothing', async () => {
      const channel = await connectedAlerts();
      const args = { channelId: channel.id, preset: 'github' };

      const asked = await call(NotificationWriteTools.applyPreset, args);
      const first = await confirmed(NotificationWriteTools.applyPreset, args);
      const second = await confirmed(NotificationWriteTools.applyPreset, args);

      expect(messageOf(asked)).toContain('- github.push when hasCommits = true');
      expect(bodyOf(first).added as unknown[]).toHaveLength(rulePresetRules.github.length);
      expect(bodyOf(second)).toEqual({ changed: false, added: [] });
      expect(await actorsOf(AuditActions.notificationPresetApplied)).toEqual([ada]);
    });

    it("lists the server's Discord channels with which are connected, then connects one", async () => {
      await connectedAlerts();
      serve(
        // The list, the confirmation's look-up, then the service's checks and test message.
        guildChannelsReply(ALERTS, DEPLOYS),
        guildChannelsReply(ALERTS, DEPLOYS),
        ...botInGuild(),
        guildChannelsReply(ALERTS, DEPLOYS),
        messageCreated(),
      );

      const listed = bodyOf(await call(NotificationWriteTools.discordChannels, {}));
      const asked = await call(NotificationWriteTools.connect, { discordChannelId: DEPLOYS.id });
      const done = await call(
        NotificationWriteTools.connect,
        { discordChannelId: DEPLOYS.id },
        { requestState: asked.result?.requestState ?? '', inputResponses: accepting(true) },
      );

      expect(listed).toEqual({
        server: { guildId: guild.id, name: 'Acme HQ' },
        channels: [
          { discordChannelId: ALERTS.id, name: 'alerts', isConnected: true },
          { discordChannelId: DEPLOYS.id, name: 'deploys', isConnected: false },
        ],
      });
      expect(messageOf(asked)).toBe(
        [
          "Connect a Discord channel to this workspace's notifications, as you?",
          'Server: Acme HQ',
          `Channel: #deploys (${DEPLOYS.id})`,
          'Name in Mocco: #deploys',
          'Mocco will post a test message there. Nothing is sent to it until it has rules.',
        ].join('\n'),
      );
      expect(bodyOf(done)).toEqual({
        changed: true,
        channel: { id: expect.any(String), name: '#deploys', status: ChannelStatuses.active, disabledReason: null },
        test: { sent: true, reason: null, channelDisabled: false },
      });
      expect(await channelNames()).toEqual(['#alerts', '#deploys']);
      expect(await auditActions()).toEqual([
        [AuditActions.notificationChannelConnected, ada],
        [AuditActions.notificationChannelConnected, ada],
      ]);
    });

    it('refuses to ask about a Discord channel the bot does not see', async () => {
      serve(guildChannelsReply(ALERTS));

      const answer = await call(NotificationWriteTools.connect, { discordChannelId: DEPLOYS.id });

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain(`Discord channel ${DEPLOYS.id} is not a text channel of that server`);
      expect(await channelsOf()).toEqual([]);
    });

    it('turns a disabled channel back on, saying why it was off', async () => {
      const channel = await connectedAlerts();
      await new ChannelRepo(t.db).disable(workspaceId, channel.id, 'Missing Access (50001)');
      serve(...botInGuild(), guildChannelsReply(ALERTS), messageCreated());

      const asked = await call(NotificationWriteTools.reenable, { channelId: channel.id });
      const done = await call(
        NotificationWriteTools.reenable,
        { channelId: channel.id },
        { requestState: asked.result?.requestState ?? '', inputResponses: accepting(true) },
      );

      expect(messageOf(asked)).toContain('Now: disabled');
      expect(messageOf(asked)).toContain('Why it is off: Missing Access (50001)');
      expect(bodyOf(done)).toMatchObject({
        changed: true,
        channel: { id: channel.id, status: ChannelStatuses.active, disabledReason: null },
        test: { sent: true },
      });
      expect(await auditActions()).toContainEqual([AuditActions.notificationChannelReenabled, ada]);
    });
  });
});
