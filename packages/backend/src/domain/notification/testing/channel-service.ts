// Test-only wiring of ChannelService over pglite with a scripted Discord (never
// imported by production code). Shared by the service and router tests.
import { randomUUID } from 'node:crypto';

import { ChannelService } from '@backend/domain/notification/ChannelService';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { DiscordGuildRepo, type DiscordGuildRow } from '@backend/domain/notification/repos/discord-guild.repo';
import { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import { RuleRepo } from '@backend/domain/notification/repos/rule.repo';
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import { DiscordChannelTypes } from '@backend/domain/notification/senders/discord-constants';
import {
  createFakeDiscordFetch,
  jsonResponse,
  type FakeReply,
} from '@backend/domain/notification/testing/fake-discord-fetch';
import { expectOne } from '@backend/infra/db/rows';
import { users } from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export const TEST_NOW = new Date('2026-09-25T12:00:00.000Z');

/** A ChannelService whose Discord answers with `script` in order (any extra call throws). */
export function createTestChannelService(db: Db, ...script: FakeReply[]) {
  const fake = createFakeDiscordFetch(...script);
  const discord = new DiscordApi({
    fetch: fake.fetch,
    botToken: 'bot-token-secret',
    now: () => TEST_NOW,
    timeoutMs: 20,
  });
  const service = new ChannelService({
    guilds: new DiscordGuildRepo(db),
    channels: new ChannelRepo(db),
    rules: new RuleRepo(db),
    deliveries: new DeliveryRepo(db),
    rateLimits: new DiscordRateLimitRepo(db),
    discord,
    now: () => TEST_NOW,
  });
  return { service, requests: fake.requests };
}

/** A guild installed for `workspaceId` (by a fresh user unless one is given). */
export async function seedGuild(
  db: Db,
  workspaceId: string,
  guildId = '800000000000000001',
  userId?: string,
): Promise<DiscordGuildRow> {
  const installer =
    userId ??
    expectOne(
      await db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
  return await new DiscordGuildRepo(db).upsert({
    workspaceId,
    guildId,
    guildName: 'Acme HQ',
    installedByUserId: installer,
    installedAt: TEST_NOW,
  });
}

/**
 * Discord's answers to `DiscordApi.getBotMember` on a fresh client: the bot's user
 * (`GET /users/@me`), then its guild membership, joined `joinedAt` (by default an hour
 * before the seed install, so the install is current).
 */
export function botInGuild(joinedAt = new Date(TEST_NOW.getTime() - 60 * 60 * 1000)): Response[] {
  return [jsonResponse(200, { id: '4242' }), jsonResponse(200, { joined_at: joinedAt.toISOString() })];
}

/** Discord's answer to `GET /guilds/{id}/channels`: two text channels and a voice channel. */
export function guildChannelsReply(...channels: { id: string; name: string }[]): Response {
  return jsonResponse(200, [
    ...channels.map((channel, index) => ({ ...channel, type: DiscordChannelTypes.GuildText, position: index })),
    { id: '1', name: 'Voice', type: 2, position: 99 },
  ]);
}

/** Discord's answer to a posted message. */
export const messageCreated = (id = '555'): Response => jsonResponse(200, { id });
