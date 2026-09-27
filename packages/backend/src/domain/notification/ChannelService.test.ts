import { randomUUID } from 'node:crypto';

import { ChannelStatuses, DeliveryStatuses } from '@mocco/common/notification';
import { RulePresets, rulePresetRules } from '@mocco/common/notification-presets';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DomainEventRepo } from '@backend/domain/events/repos/domain-event.repo';
import { CHANNEL_TEST_MESSAGE, ChannelService } from '@backend/domain/notification/ChannelService';
import {
  DiscordChannelNotInGuildError,
  DiscordGuildNotFoundError,
  DiscordNotConfiguredError,
  DiscordReinstallRequiredError,
  DiscordRequestFailedError,
  NotificationChannelExistsError,
  NotificationChannelNotFoundError,
  NotificationRuleExistsError,
  NotificationRuleNotFoundError,
  UnknownRuleEventTypeError,
} from '@backend/domain/notification/errors';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { DiscordGuildRepo, type DiscordGuildRow } from '@backend/domain/notification/repos/discord-guild.repo';
import { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import { RuleRepo } from '@backend/domain/notification/repos/rule.repo';
import { DiscordJsonErrorCodes } from '@backend/domain/notification/senders/discord-constants';
import {
  botInGuild,
  createTestChannelService,
  guildChannelsReply,
  messageCreated,
  seedGuild,
  TEST_NOW,
} from '@backend/domain/notification/testing/channel-service';
import { jsonResponse } from '@backend/domain/notification/testing/fake-discord-fetch';
import { seedWorkspace } from '@backend/domain/notification/testing/seed';
import { discordRateLimits, notificationDeliveries, notificationRules } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const ALERTS = { id: '700000000000000001', name: 'alerts' };
const DEPLOYS = { id: '700000000000000002', name: 'deploys' };

describe('ChannelService (pglite, fake Discord)', () => {
  let t: TestDb;
  let workspaceId: string;
  let guild: DiscordGuildRow;

  beforeEach(async () => {
    t = await createTestDb();
    workspaceId = await seedWorkspace(t.db);
    guild = await seedGuild(t.db, workspaceId);
  });

  afterEach(async () => {
    await t.close();
  });

  const createAlerts = async (...sendReplies: Response[]) => {
    const { service, requests } = createTestChannelService(
      t.db,
      ...botInGuild(),
      guildChannelsReply(ALERTS, DEPLOYS),
      ...sendReplies,
    );
    const created = await service.createChannel(workspaceId, { guildId: guild.id, channelId: ALERTS.id });
    return { service, requests, ...created };
  };

  describe('guilds and their channels', () => {
    it('lists installed guilds and a guild’s text channels only', async () => {
      const { service, requests } = createTestChannelService(t.db, guildChannelsReply(ALERTS, DEPLOYS));

      const guilds = await service.listGuilds(workspaceId);
      expect(guilds.map(row => row.guildId)).toEqual([guild.guildId]);
      expect(await service.listGuildChannels(workspaceId, guild.id)).toEqual([
        { id: ALERTS.id, name: 'alerts', type: 0 },
        { id: DEPLOYS.id, name: 'deploys', type: 0 },
      ]);
      expect(new URL(requests[0]?.url ?? '').pathname).toBe(`/api/v10/guilds/${guild.guildId}/channels`);
    });

    it("never lists another workspace's guild", async () => {
      const other = await seedWorkspace(t.db, 'Other');
      const { service, requests } = createTestChannelService(t.db);

      expect(await service.listGuilds(other)).toEqual([]);
      await expect(service.listGuildChannels(other, guild.id)).rejects.toBeInstanceOf(DiscordGuildNotFoundError);
      expect(requests).toHaveLength(0);
    });

    it('surfaces a Discord failure and a missing bot token as domain errors', async () => {
      const { service } = createTestChannelService(
        t.db,
        jsonResponse(403, { message: 'Missing Access', code: DiscordJsonErrorCodes.MissingAccess }),
      );
      await expect(service.listGuildChannels(workspaceId, guild.id)).rejects.toThrow(
        new DiscordRequestFailedError('Discord 403 (code 50001): Missing Access'),
      );

      const unconfigured = new ChannelService({
        guilds: new DiscordGuildRepo(t.db),
        channels: new ChannelRepo(t.db),
        rules: new RuleRepo(t.db),
        deliveries: new DeliveryRepo(t.db),
        rateLimits: new DiscordRateLimitRepo(t.db),
        discord: undefined,
        now: () => TEST_NOW,
      });
      await expect(unconfigured.listGuildChannels(workspaceId, guild.id)).rejects.toBeInstanceOf(
        DiscordNotConfiguredError,
      );
      expect(await unconfigured.listChannels(workspaceId)).toEqual([]);
    });
  });

  describe('createChannel', () => {
    it('stores the channel and posts the test message', async () => {
      const { channel, test, requests } = await createAlerts(messageCreated());

      expect(test).toEqual({ sent: true, reason: null, channelDisabled: false });
      expect(channel).toMatchObject({
        workspaceId,
        kind: 'discord',
        name: '#alerts',
        externalId: ALERTS.id,
        config: { guildId: guild.guildId, channelId: ALERTS.id, channelName: 'alerts' },
        status: ChannelStatuses.active,
      });
      expect(requests.map(request => new URL(request.url).pathname)).toEqual([
        '/api/v10/users/@me',
        `/api/v10/guilds/${guild.guildId}/members/4242`,
        `/api/v10/guilds/${guild.guildId}/channels`,
        `/api/v10/channels/${ALERTS.id}/messages`,
      ]);
      expect(requests[3]?.body).toContain(CHANNEL_TEST_MESSAGE.title);
    });

    it('stores a channel the bot cannot post to as disabled, with the reason', async () => {
      const { channel, test } = await createAlerts(
        jsonResponse(403, { message: 'Missing Permissions', code: DiscordJsonErrorCodes.MissingPermissions }),
      );

      expect(test).toEqual({
        sent: false,
        reason: 'Discord 403 (code 50013): Missing Permissions',
        channelDisabled: true,
      });
      expect(channel).toMatchObject({
        status: ChannelStatuses.disabled,
        disabledReason: 'Discord 403 (code 50013): Missing Permissions',
      });
    });

    it('keeps the channel active on a transient test failure', async () => {
      const { channel, test } = await createAlerts(jsonResponse(502, {}));

      expect(test).toEqual({ sent: false, reason: 'Discord 502', channelDisabled: false });
      expect(channel.status).toBe(ChannelStatuses.active);
    });

    it('skips the test message while the channel bucket is blocked', async () => {
      await new DiscordRateLimitRepo(t.db).block(`channel:${ALERTS.id}`, new Date(TEST_NOW.getTime() + 60_000));

      const { test, requests } = await createAlerts();

      expect(test).toMatchObject({ sent: false, channelDisabled: false });
      expect(requests).toHaveLength(3);
    });

    it('refuses to call Discord while the bot is globally rate limited', async () => {
      await new DiscordRateLimitRepo(t.db).block('global', new Date(TEST_NOW.getTime() + 60_000));
      const { service, requests } = createTestChannelService(t.db);

      await expect(
        service.createChannel(workspaceId, { guildId: guild.id, channelId: ALERTS.id }),
      ).rejects.toBeInstanceOf(DiscordRequestFailedError);
      expect(requests).toHaveLength(0);
    });

    it('records the guild bucket when listing channels is rate limited, and waits for it', async () => {
      const { service } = createTestChannelService(
        t.db,
        jsonResponse(429, { message: 'slow', retry_after: 5 }, { 'X-RateLimit-Scope': 'user' }),
      );
      await expect(service.listGuildChannels(workspaceId, guild.id)).rejects.toThrow(DiscordRequestFailedError);

      const [row] = await t.db.select().from(discordRateLimits);
      expect(row).toEqual({ bucket: `guild:${guild.guildId}`, blockedUntil: new Date(TEST_NOW.getTime() + 5000) });
      const next = createTestChannelService(t.db);
      await expect(next.service.listGuildChannels(workspaceId, guild.id)).rejects.toThrow(DiscordRequestFailedError);
      expect(next.requests).toHaveLength(0);
    });

    it('removes a stale install (the bot re-joined after it) with its channels, and asks to reconnect', async () => {
      await createAlerts(messageCreated());
      const rejoined = new Date(guild.installedAt.getTime() + 60 * 60 * 1000);
      const { service } = createTestChannelService(t.db, ...botInGuild(rejoined));

      await expect(
        service.createChannel(workspaceId, { guildId: guild.id, channelId: DEPLOYS.id }),
      ).rejects.toBeInstanceOf(DiscordReinstallRequiredError);
      expect(await service.listGuilds(workspaceId)).toEqual([]);
      expect(await service.listChannels(workspaceId)).toEqual([]);
    });

    it('treats a bot that left the guild as a stale install', async () => {
      const { service } = createTestChannelService(
        t.db,
        jsonResponse(200, { id: '4242' }),
        jsonResponse(404, { message: 'Unknown Member', code: DiscordJsonErrorCodes.UnknownMember }),
      );

      await expect(
        service.createChannel(workspaceId, { guildId: guild.id, channelId: ALERTS.id }),
      ).rejects.toBeInstanceOf(DiscordReinstallRequiredError);
      expect(await service.listGuilds(workspaceId)).toEqual([]);
    });

    it('refuses a channel the bot does not list in that guild (a foreign or made-up id)', async () => {
      const { service } = createTestChannelService(t.db, ...botInGuild(), guildChannelsReply(DEPLOYS));

      await expect(
        service.createChannel(workspaceId, { guildId: guild.id, channelId: ALERTS.id }),
      ).rejects.toBeInstanceOf(DiscordChannelNotInGuildError);
      expect(await service.listChannels(workspaceId)).toEqual([]);
    });

    it("refuses another workspace's guild", async () => {
      const other = await seedWorkspace(t.db, 'Other');
      const { service, requests } = createTestChannelService(t.db);

      await expect(service.createChannel(other, { guildId: guild.id, channelId: ALERTS.id })).rejects.toBeInstanceOf(
        DiscordGuildNotFoundError,
      );
      expect(requests).toHaveLength(0);
    });

    it('refuses the same Discord channel twice in a workspace', async () => {
      await createAlerts(messageCreated());
      const { service } = createTestChannelService(t.db, ...botInGuild(), guildChannelsReply(ALERTS));

      await expect(
        service.createChannel(workspaceId, { guildId: guild.id, channelId: ALERTS.id }),
      ).rejects.toBeInstanceOf(NotificationChannelExistsError);
    });

    it('re-enables a disabled channel only after the install, listing and test message check out', async () => {
      const { channel } = await createAlerts(
        jsonResponse(403, { message: 'Missing Access', code: DiscordJsonErrorCodes.MissingAccess }),
      );

      const stillBroken = createTestChannelService(
        t.db,
        ...botInGuild(),
        guildChannelsReply(ALERTS),
        jsonResponse(403, { message: 'Missing Permissions', code: DiscordJsonErrorCodes.MissingPermissions }),
      );
      const retried = await stillBroken.service.reenableChannel(workspaceId, channel.id);
      expect(retried.test).toMatchObject({ sent: false, channelDisabled: true });
      expect(retried.channel).toMatchObject({
        status: ChannelStatuses.disabled,
        disabledReason: 'Discord 403 (code 50013): Missing Permissions',
      });

      const gone = createTestChannelService(t.db, ...botInGuild(), guildChannelsReply(DEPLOYS));
      await expect(gone.service.reenableChannel(workspaceId, channel.id)).rejects.toBeInstanceOf(
        DiscordChannelNotInGuildError,
      );

      const fixed = createTestChannelService(t.db, ...botInGuild(), guildChannelsReply(ALERTS), messageCreated());
      const reenabled = await fixed.service.reenableChannel(workspaceId, channel.id);
      expect(reenabled.test).toEqual({ sent: true, reason: null, channelDisabled: false });
      expect(reenabled.channel).toMatchObject({ status: ChannelStatuses.active, disabledReason: null });
    });

    it('deletes a channel with its rules', async () => {
      const { service, channel } = await createAlerts(messageCreated());

      await service.applyDefaultRules(workspaceId, channel.id, RulePresets.mocco);
      await service.deleteChannel(workspaceId, channel.id);
      expect(await service.listChannels(workspaceId)).toEqual([]);
      expect(await t.db.select().from(notificationRules)).toEqual([]);
      await expect(service.deleteChannel(workspaceId, channel.id)).rejects.toBeInstanceOf(
        NotificationChannelNotFoundError,
      );
      await expect(service.reenableChannel(workspaceId, channel.id)).rejects.toBeInstanceOf(
        NotificationChannelNotFoundError,
      );
    });
  });

  describe('rules', () => {
    it('adds exact catalog and inbound types and prefix wildcards; rejects unknown exact types', async () => {
      const { service, channel } = await createAlerts(messageCreated());

      await service.addRule(workspaceId, channel.id, { eventType: 'gate.pending', sourceId: null });
      await service.addRule(workspaceId, channel.id, {
        eventType: 'vercel.deployment.succeeded',
        sourceId: randomUUID(),
        filter: { target: 'production' },
      });
      await service.addRule(workspaceId, channel.id, { eventType: 'github.*', sourceId: null });
      await expect(
        service.addRule(workspaceId, channel.id, { eventType: 'gate.unknown', sourceId: null }),
      ).rejects.toBeInstanceOf(UnknownRuleEventTypeError);

      const rules = await service.listRules(workspaceId, channel.id);
      expect(new Set(rules.map(rule => rule.eventType))).toEqual(
        new Set(['gate.pending', 'vercel.deployment.succeeded', 'github.*']),
      );
    });

    it('refuses a duplicate rule and removes rules by id within the workspace', async () => {
      const { service, channel } = await createAlerts(messageCreated());
      const rule = await service.addRule(workspaceId, channel.id, {
        eventType: 'run.failed',
        sourceId: null,
        filter: { repo: 'a/b' },
      });

      await expect(
        service.addRule(workspaceId, channel.id, { eventType: 'run.failed', sourceId: null, filter: { repo: 'a/b' } }),
      ).rejects.toBeInstanceOf(NotificationRuleExistsError);

      const other = await seedWorkspace(t.db, 'Other');
      await expect(service.removeRule(other, rule.id)).rejects.toBeInstanceOf(NotificationRuleNotFoundError);
      await service.removeRule(workspaceId, rule.id);
      expect(await service.listRules(workspaceId, channel.id)).toEqual([]);
    });

    it('applies a preset once: the mocco preset ignores a source, a source preset keeps it', async () => {
      const { service, channel } = await createAlerts(messageCreated());
      const sourceId = randomUUID();

      const mocco = await service.applyDefaultRules(workspaceId, channel.id, RulePresets.mocco, sourceId);
      expect(mocco.map(rule => rule.eventType)).toEqual(rulePresetRules.mocco.map(rule => rule.eventType));
      expect(mocco.every(rule => rule.sourceId === null)).toBe(true);
      expect(await service.applyDefaultRules(workspaceId, channel.id, RulePresets.mocco)).toEqual([]);

      const vercel = await service.applyDefaultRules(workspaceId, channel.id, RulePresets.vercel, sourceId);
      expect(vercel).toHaveLength(3);
      expect(vercel.find(rule => rule.eventType === 'vercel.deployment.succeeded')).toMatchObject({
        sourceId,
        filter: { target: 'production' },
      });
      const github = await service.applyDefaultRules(workspaceId, channel.id, RulePresets.github);
      expect(github.find(rule => rule.eventType === 'github.push')?.filter).toEqual({ hasCommits: true });
      expect(await service.applyDefaultRules(workspaceId, channel.id, RulePresets.sentry)).toHaveLength(1);
    });

    it("never reads or writes rules of another workspace's channel", async () => {
      const { service, channel } = await createAlerts(messageCreated());
      const other = await seedWorkspace(t.db, 'Other');

      await expect(service.listRules(other, channel.id)).rejects.toBeInstanceOf(NotificationChannelNotFoundError);
      await expect(
        service.addRule(other, channel.id, { eventType: 'gate.pending', sourceId: null }),
      ).rejects.toBeInstanceOf(NotificationChannelNotFoundError);
      await expect(service.applyDefaultRules(other, channel.id, RulePresets.mocco)).rejects.toBeInstanceOf(
        NotificationChannelNotFoundError,
      );
    });
  });

  describe('deliveries', () => {
    it('lists recent deliveries of the workspace, filtered by channel and status', async () => {
      const { service, channel } = await createAlerts(messageCreated());
      const events = new DomainEventRepo(t.db);
      const deliveries = new DeliveryRepo(t.db);
      const seedDelivery = async (workspace: string, channelId: string | null) => {
        const { event } = await events.insert({
          workspaceId: workspace,
          projectId: null,
          type: 'gate.pending',
          subjectType: 'run_gate',
          subjectId: randomUUID(),
          payload: {},
          dedupeKey: null,
          occurredAt: TEST_NOW,
        });
        const created = await deliveries.createQueued(
          { workspaceId: workspace, channelId, eventId: event.id, ruleId: null, message: CHANNEL_TEST_MESSAGE },
          async () => await Promise.resolve(null),
        );
        return created?.delivery.id ?? '';
      };
      const queued = await seedDelivery(workspaceId, channel.id);
      const sent = await seedDelivery(workspaceId, channel.id);
      const orphan = await seedDelivery(workspaceId, null);
      await seedDelivery(await seedWorkspace(t.db, 'Other'), null);
      await t.db
        .update(notificationDeliveries)
        .set({ status: DeliveryStatuses.sent })
        .where(eq(notificationDeliveries.id, sent));

      const ids = async (options: Parameters<ChannelService['listDeliveries']>[1]) => {
        const rows = await service.listDeliveries(workspaceId, options);
        return new Set(rows.map(row => row.id));
      };
      expect(await ids({})).toEqual(new Set([queued, sent, orphan]));
      expect(await ids({ channelId: channel.id })).toEqual(new Set([queued, sent]));
      expect(await ids({ status: DeliveryStatuses.sent })).toEqual(new Set([sent]));
      expect(await service.listDeliveries(workspaceId, { limit: 1 })).toHaveLength(1);
    });
  });
});
