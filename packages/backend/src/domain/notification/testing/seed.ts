// Test-only seeding for the notification domain (never imported by production code):
// workspaces, Discord channels and rules over pglite, through the real repos.
import { randomInt, randomUUID } from 'node:crypto';

import { ChannelKinds } from '@mocco/common/notification';

import { ChannelRepo, type ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import { DiscordGuildRepo } from '@backend/domain/notification/repos/discord-guild.repo';
import { RuleRepo, type NewRule } from '@backend/domain/notification/repos/rule.repo';
import { expectOne } from '@backend/infra/db/rows';
import { workspaces } from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

export async function seedWorkspace(db: Db, name = 'W'): Promise<string> {
  return expectOne(await db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
}

const SEED_GUILD_ID = '900000000000000001';

/** A Discord channel with a fresh snowflake-like id, in the workspace's seed guild install. */
export async function seedChannel(db: Db, workspaceId: string, name = 'alerts'): Promise<ChannelRow> {
  const channelId = String(randomInt(1, 2 ** 47));
  const guild = await new DiscordGuildRepo(db).upsert({
    workspaceId,
    guildId: SEED_GUILD_ID,
    guildName: 'Seed',
    installedByUserId: null,
    installedAt: new Date(),
  });
  return await new ChannelRepo(db).insert({
    workspaceId,
    kind: ChannelKinds.discord,
    name,
    config: { guildId: SEED_GUILD_ID, channelId, channelName: name },
    externalId: channelId,
    guildId: guild.id,
  });
}

export async function seedRule(
  db: Db,
  channel: ChannelRow,
  rule: Partial<Pick<NewRule, 'eventType' | 'sourceId' | 'filter'>> = {},
): Promise<void> {
  await new RuleRepo(db).insertMany([
    {
      workspaceId: channel.workspaceId,
      channelId: channel.id,
      eventType: rule.eventType ?? 'gate.*',
      sourceId: rule.sourceId ?? null,
      filter: rule.filter ?? {},
    },
  ]);
}
