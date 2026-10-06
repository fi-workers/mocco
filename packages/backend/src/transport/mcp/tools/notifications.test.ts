// `mocco_notifications_*` over a real database, through the real HTTP handler.
//
// The reads are only as safe as the scoping in front of them and the fields they pick, so
// many of these tests are about what a caller cannot see: a workspace they are not in
// reads the same whether it exists or not, another workspace's channel reads the same as
// one that does not exist, and no answer, concise or detailed, carries a sealed secret, a
// signing secret or the bot token.
import { randomUUID } from 'node:crypto';

import { DomainEventTypes } from '@mocco/common/events';
import { InboundKinds } from '@mocco/common/inbound';
import { ChannelStatuses, DeliveryStatuses } from '@mocco/common/notification';
import { ActivityChannelResultKinds, ActivityItemKinds } from '@mocco/common/notification-activity';
import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createEventBus } from '@backend/domain/events/subscriptions';
import { InboundReceiptRepo } from '@backend/domain/inbound/repos/inbound-receipt.repo';
import { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import { createInboundHarness, ingestKeyOf, signedDelivery } from '@backend/domain/inbound/testing/harness';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { ActivityService } from '@backend/domain/notification/ActivityService';
import { NotificationSubscribers } from '@backend/domain/notification/constants';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { RuleRepo } from '@backend/domain/notification/repos/rule.repo';
import { createTestChannelService } from '@backend/domain/notification/testing/channel-service';
import { seedChannel, seedRule, seedWorkspace } from '@backend/domain/notification/testing/seed';
import { expectOne } from '@backend/infra/db/rows';
import {
  inboundReceipts,
  members,
  notificationChannels,
  notificationDeliveries,
  notificationRules,
  users,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { EventBus } from '@backend/domain/events/EventBus';
import type { ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import type { McpToolDeps } from '@backend/transport/mcp/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const refuse = () => {
  throw new Error('the notification tools must not reach another domain');
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

const NOTIFICATION_TOOLS = [
  'mocco_notifications_activity_search',
  'mocco_notifications_channels_search',
  'mocco_notifications_rules_search',
];

/** Values that must never appear in any answer. */
const CHANNEL_SECRET = 'sealed-channel-secret-do-not-leak';
const VERCEL_SECRET = 'vercel-signing-secret-do-not-leak';
const BOT_TOKEN = 'bot-token-secret';

/** Every tool that reads the workspace's notifications must refuse without the services. */
const otherDeps = (scope: WorkspaceScope): Omit<McpToolDeps, 'notifications' | 'notificationActivity' | 'inbound'> => ({
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
  messengerInbox: { list: refuse, get: refuse, write: refuse, assign: refuse, assignable: refuse },
  feedbackBoards: { listBoards: refuse, getBoard: refuse },
  feedbackPosts: { list: refuse, get: refuse, requirePost: refuse, setStatus: refuse },
  scope,
  projects: { resolve: refuse, resolveWorkspace: refuse },
  settings: { agentsMayDecide: refuse },
  confirmations: undefined,
});

describe('mocco_notifications_* (pglite, over HTTP)', () => {
  let t: TestDb;
  let bus: EventBus;
  let clock: number;
  let handler: McpHttpHandler;
  let scope: WorkspaceScope;
  let ada: string;
  let bob: string;
  let mine: string;
  let theirs: string;
  let deploys: ChannelRow;
  let previews: ChannelRow;
  let broken: ChannelRow;
  let alerts: ChannelRow;
  let theirChannel: ChannelRow;
  let vercelSourceId: string;
  let receiptId: string;
  let gateEventId: string;

  // Every call is a second later, starting a day after the real clock: events are
  // ordered, and channels seeded before them (a DB-default created_at) are older.
  const now = () => {
    clock += 1000;
    return new Date(clock);
  };

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

  /** Bob is a plain member: every read the console allows a member, he gets here. */
  const call = async (tool: string, args: Record<string, unknown>, userId = bob) =>
    await rpc(userId, 'tools/call', { name: tool, arguments: args });

  const addUser = async (name: string) =>
    expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name, email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;

  /** The ids of what a search finds, in its order. */
  async function idsOf(tool: string, key: string, args: Record<string, unknown>) {
    return (bodyOf(await call(tool, args))[key] as Row[]).map(row => row.id);
  }

  beforeEach(async () => {
    t = await createTestDb();
    clock = Date.now() + 86_400_000;
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now,
      runOne: async () => await Promise.resolve(null),
      waitUntil: () => {},
    });
    bus = createEventBus({ db: t.db, queue, now, appOrigin: 'https://www.mocco.test' });

    ada = await addUser('Ada');
    bob = await addUser('Bob');
    mine = await seedWorkspace(t.db, 'Acme');
    theirs = await seedWorkspace(t.db, 'Globex');
    await t.db.insert(members).values([
      { organizationId: mine, userId: ada, role: 'owner' },
      { organizationId: mine, userId: bob, role: 'member' },
    ]);

    // Four channels: production deploys, previews (its filter will not match a production
    // deploy), one the bot lost access to, and gate alerts. `deploys` carries a sealed
    // secret, as a customer bot token would be stored.
    deploys = await seedChannel(t.db, mine, 'deploys');
    previews = await seedChannel(t.db, mine, 'previews');
    broken = await seedChannel(t.db, mine, 'broken');
    alerts = await seedChannel(t.db, mine, 'gate-alerts');
    await t.db
      .update(notificationChannels)
      .set({ secretSealed: CHANNEL_SECRET })
      .where(eq(notificationChannels.id, deploys.id));
    await seedRule(t.db, deploys, { eventType: 'vercel.deployment.succeeded', filter: { target: 'production' } });
    await seedRule(t.db, previews, { eventType: 'vercel.deployment.succeeded', filter: { target: 'preview' } });
    await seedRule(t.db, broken, { eventType: 'vercel.*' });
    await seedRule(t.db, alerts, { eventType: 'gate.*' });
    await new ChannelRepo(t.db).disable(mine, broken.id, 'Missing Access (50001)');
    // Rows inserted in the same instant tie on created_at; space them out (still well
    // before the events) so oldest-first is the order they were made in.
    await Promise.all(
      [deploys, previews, broken, alerts].map(async (channel, index) => {
        const at = new Date(Date.now() + index * 1000);
        await t.db.update(notificationChannels).set({ createdAt: at }).where(eq(notificationChannels.id, channel.id));
        await t.db.update(notificationRules).set({ createdAt: at }).where(eq(notificationRules.channelId, channel.id));
      }),
    );

    // A Vercel source receives one production deploy; its delivery to `deploys` failed.
    const inbound = createInboundHarness(t.db, { now, bus });
    const created = await inbound.sources.create(mine, ada, {
      kind: InboundKinds.vercel,
      name: 'Acme web',
      secret: VERCEL_SECRET,
    });
    vercelSourceId = created.source.id;
    await inbound.inbound.ingest({
      ingestKey: ingestKeyOf(created.source.ingestUrl),
      ...signedDelivery(InboundKinds.vercel, VERCEL_SECRET),
    });
    const receipt = expectOne(
      await t.db
        .select()
        .from(inboundReceipts)
        .where(eq(inboundReceipts.sourceId, vercelSourceId))
        .orderBy(desc(inboundReceipts.seq))
        .limit(1),
    );
    receiptId = receipt.id;
    await bus.deliver(receipt.domainEventId ?? '', NotificationSubscribers.vercel.name);
    await t.db
      .update(notificationDeliveries)
      .set({ status: DeliveryStatuses.failed, attempts: 1, responseCode: 403, error: 'Missing Permissions (50013)' })
      .where(eq(notificationDeliveries.channelId, deploys.id));

    // Then a gate pauses, and gate-alerts gets it.
    const runId = randomUUID();
    const { event } = await bus.publish({
      type: DomainEventTypes.gatePending,
      workspaceId: mine,
      subject: { type: 'run_gate', id: randomUUID() },
      payload: {
        workspaceId: mine,
        runId,
        repoFullName: 'acme/web',
        pipelineName: 'deploy',
        commitSha: 'abc1234',
        linkPath: `/workspaces/${mine}/runs/${runId}`,
        gateName: 'production',
        gateItemIndex: 1,
        facts: { repo: 'acme/web', pipeline: 'deploy', gate: 'production' },
      },
    });
    gateEventId = event.id;
    await bus.deliver(event.id, NotificationSubscribers.gate.name);

    // Another workspace, with its own channel, that neither Ada nor Bob is in.
    theirChannel = await seedChannel(t.db, theirs, 'their-secret-channel');
    await seedRule(t.db, theirChannel, { eventType: 'github.*' });

    scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    handler = createMcpHttpHandler({
      ...otherDeps(scope),
      notifications: createTestChannelService(t.db).service,
      notificationActivity: new ActivityService({
        receipts: new InboundReceiptRepo(t.db),
        sources: new InboundSourceRepo(t.db),
        channels: new ChannelRepo(t.db),
        rules: new RuleRepo(t.db),
        deliveries: new DeliveryRepo(t.db),
      }),
      inbound: undefined,
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('declares every notification read tool read-only', async () => {
    const listed = await rpc(bob, 'tools/list', {});

    // The tools that change settings are tested in notifications-write.test.ts.
    const tools = listed.result?.tools?.filter(tool => NOTIFICATION_TOOLS.includes(tool.name)) ?? [];
    expect(new Set(tools.map(tool => tool.name))).toEqual(new Set(NOTIFICATION_TOOLS));
    expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  describe('mocco_notifications_channels_search', () => {
    it("lists a plain member's workspace channels oldest first, concise unless asked", async () => {
      const body = bodyOf(await call('mocco_notifications_channels_search', {}));

      expect((body.channels as Row[]).map(channel => channel.name)).toEqual([
        'deploys',
        'previews',
        'broken',
        'gate-alerts',
      ]);
      expect((body.channels as Row[])[2]).toEqual({
        id: broken.id,
        kind: 'discord',
        name: 'broken',
        status: ChannelStatuses.disabled,
        disabledReason: 'Missing Access (50001)',
      });
      expect(body).not.toHaveProperty('nextAfter');
    });

    it('adds the Discord channel and server when asked', async () => {
      const body = bodyOf(
        await call('mocco_notifications_channels_search', { query: 'DEPLOY', responseFormat: 'detailed' }),
      );

      expect(body.channels).toEqual([
        {
          id: deploys.id,
          kind: 'discord',
          name: 'deploys',
          status: ChannelStatuses.active,
          disabledReason: null,
          discord: {
            serverId: deploys.config.guildId,
            channelId: deploys.config.channelId,
            channelName: 'deploys',
          },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ]);
    });

    it('filters by status and pages oldest first', async () => {
      expect(await idsOf('mocco_notifications_channels_search', 'channels', { status: 'disabled' })).toEqual([
        broken.id,
      ]);

      const first = bodyOf(await call('mocco_notifications_channels_search', { limit: 3 }));
      const second = bodyOf(await call('mocco_notifications_channels_search', { limit: 3, after: first.nextAfter }));

      expect((first.channels as Row[]).map(channel => channel.id)).toEqual([deploys.id, previews.id, broken.id]);
      expect(first.nextAfter).toEqual(expect.any(String));
      expect((second.channels as Row[]).map(channel => channel.id)).toEqual([alerts.id]);
      expect(second).not.toHaveProperty('nextAfter');
    });
  });

  describe('mocco_notifications_rules_search', () => {
    it('reads every channel’s rules with the channel they route to', async () => {
      const body = bodyOf(await call('mocco_notifications_rules_search', {}));
      const rules = body.rules as Row[];

      expect(rules.map(rule => (rule.channel as Row).name)).toEqual(['deploys', 'previews', 'broken', 'gate-alerts']);
      expect(rules[0]).toEqual({
        id: expect.any(String),
        channel: { id: deploys.id, name: 'deploys' },
        eventType: 'vercel.deployment.succeeded',
        sourceId: null,
        filter: { target: 'production' },
      });
    });

    it("adds the channel's status and when the rule was added when asked", async () => {
      const body = bodyOf(
        await call('mocco_notifications_rules_search', { channelId: broken.id, responseFormat: 'detailed' }),
      );

      expect(body.rules).toEqual([
        {
          id: expect.any(String),
          channel: { id: broken.id, name: 'broken', status: ChannelStatuses.disabled },
          eventType: 'vercel.*',
          sourceId: null,
          filter: {},
          createdAt: expect.any(String),
        },
      ]);
    });

    it('filters by event type text and source, and pages', async () => {
      const vercel = bodyOf(await call('mocco_notifications_rules_search', { eventType: 'VERCEL' }));
      const gate = bodyOf(await call('mocco_notifications_rules_search', { eventType: 'gate.' }));
      const bound = bodyOf(await call('mocco_notifications_rules_search', { sourceId: vercelSourceId }));
      const first = bodyOf(await call('mocco_notifications_rules_search', { limit: 2 }));
      const rest = bodyOf(await call('mocco_notifications_rules_search', { limit: 2, after: first.nextAfter }));

      expect(vercel.rules).toHaveLength(3);
      expect((gate.rules as Row[]).map(rule => (rule.channel as Row).id)).toEqual([alerts.id]);
      expect(bound.rules).toEqual([]);
      expect(first.rules).toHaveLength(2);
      expect((rest.rules as Row[]).map(rule => (rule.channel as Row).name)).toEqual(['broken', 'gate-alerts']);
      expect(rest).not.toHaveProperty('nextAfter');
    });

    it("refuses another workspace's channel exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const foreign = await call('mocco_notifications_rules_search', { channelId: theirChannel.id });
      const missing = await call('mocco_notifications_rules_search', { channelId: nowhere });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('not found');
      expect(textOf(foreign).replace(theirChannel.id, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(foreign)).not.toContain('their-secret-channel');
    });
  });

  describe('mocco_notifications_activity_search', () => {
    it('says what every channel got from each event, newest first, concise unless asked', async () => {
      const body = bodyOf(await call('mocco_notifications_activity_search', {}));
      const items = body.items as Row[];

      expect(items.map(item => [item.kind, item.id])).toEqual([
        [ActivityItemKinds.event, gateEventId],
        [ActivityItemKinds.receipt, receiptId],
      ]);
      expect(items[1]).toEqual({
        kind: ActivityItemKinds.receipt,
        id: receiptId,
        occurredAt: expect.any(String),
        source: 'Acme web',
        eventType: 'vercel.deployment.succeeded',
        outcome: 'published',
        reason: null,
        channels: [
          {
            channelId: deploys.id,
            channelName: 'deploys',
            result: DeliveryStatuses.failed,
            reason: 'Missing Permissions (50013)',
          },
          {
            channelId: previews.id,
            channelName: 'previews',
            result: ActivityChannelResultKinds.no_match,
            reason: 'rule `vercel.deployment.succeeded` needs target = "preview" (the event has "production")',
          },
          {
            channelId: broken.id,
            channelName: 'broken',
            result: ActivityChannelResultKinds.channel_disabled,
            reason: 'Missing Access (50001)',
          },
          {
            channelId: alerts.id,
            channelName: 'gate-alerts',
            result: ActivityChannelResultKinds.no_match,
            reason: expect.any(String),
          },
        ],
      });
      expect(body).not.toHaveProperty('nextCursor');
    });

    it("adds the receipt's sequence, the event id and each delivery's attempts when asked", async () => {
      const body = bodyOf(
        await call('mocco_notifications_activity_search', { channelId: deploys.id, responseFormat: 'detailed' }),
      );
      const [receipt] = body.items as Row[];

      expect(receipt).toMatchObject({
        id: receiptId,
        seq: expect.stringMatching(/^\d+$/u),
        source: { id: vercelSourceId, name: 'Acme web', kind: InboundKinds.vercel },
        eventId: expect.any(String),
        channels: [
          {
            kind: ActivityChannelResultKinds.delivery,
            channelId: deploys.id,
            channelName: 'deploys',
            delivery: {
              status: DeliveryStatuses.failed,
              attempts: 1,
              responseCode: 403,
              error: 'Missing Permissions (50013)',
            },
          },
        ],
      });
    });

    it('filters by source and outcome', async () => {
      const bySource = bodyOf(await call('mocco_notifications_activity_search', { sourceId: vercelSourceId }));
      const ignored = bodyOf(await call('mocco_notifications_activity_search', { outcome: 'ignored' }));

      expect((bySource.items as Row[]).map(item => item.id)).toEqual([receiptId]);
      expect(ignored.items).toEqual([]);
    });

    it('pages the merged trace with an opaque cursor, and refuses one it did not hand out', async () => {
      const first = bodyOf(await call('mocco_notifications_activity_search', { limit: 1 }));
      const second = bodyOf(await call('mocco_notifications_activity_search', { limit: 1, cursor: first.nextCursor }));
      const forged = await call('mocco_notifications_activity_search', { cursor: 'not-a-cursor' });

      expect((first.items as Row[]).map(item => item.id)).toEqual([gateEventId]);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect((second.items as Row[]).map(item => item.id)).toEqual([receiptId]);
      expect(forged.result?.isError).toBe(true);
      expect(textOf(forged)).toContain('not one this tool returned');
    });
  });

  it('never answers with a sealed secret, a signing secret or the bot token', async () => {
    const answers = await Promise.all(
      NOTIFICATION_TOOLS.flatMap(tool => [call(tool, {}), call(tool, { responseFormat: 'detailed' })]),
    );

    const everything = answers.map(answer => textOf(answer)).join('\n');

    expect(answers.map(answer => answer.result?.isError ?? false)).toEqual(answers.map(() => false));
    expect(everything).not.toContain(CHANNEL_SECRET);
    expect(everything).not.toContain(VERCEL_SECRET);
    expect(everything).not.toContain(BOT_TOKEN);
    expect(everything).not.toMatch(/secretSealed|secret_sealed|externalId|ingestKey|workspaceId/u);
  });

  it('refuses a workspace the caller is not in exactly as one that does not exist', async () => {
    const nowhere = randomUUID();

    const existing = await Promise.all(NOTIFICATION_TOOLS.map(async tool => await call(tool, { workspaceId: theirs })));
    const missing = await Promise.all(NOTIFICATION_TOOLS.map(async tool => await call(tool, { workspaceId: nowhere })));

    expect(existing.map(answer => answer.result?.isError)).toEqual([true, true, true]);
    expect(existing.map(answer => textOf(answer).replace(theirs, '<id>'))).toEqual(
      missing.map(answer => textOf(answer).replace(nowhere, '<id>')),
    );
    expect(textOf(existing[0] ?? {})).toContain('No workspace');
    expect(existing.map(answer => textOf(answer)).join('\n')).not.toContain('their-secret-channel');
  });

  it('says so when this server does not compose notifications', async () => {
    handler = createMcpHttpHandler({ ...otherDeps(scope), inbound: undefined });

    const answers = await Promise.all(NOTIFICATION_TOOLS.map(async tool => await call(tool, {})));

    expect(answers.map(answer => answer.result?.isError)).toEqual([true, true, true]);
    expect(answers.every(answer => textOf(answer).includes('not available on this Mocco server'))).toBe(true);
  });
});
