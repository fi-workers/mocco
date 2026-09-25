import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DISCORD_CONNECT_STATE_TTL_MS,
  DiscordInstallService,
} from '@backend/domain/notification/DiscordInstallService';
import { DiscordConnectStateInvalidError, DiscordInstallFailedError } from '@backend/domain/notification/errors';
import { DiscordConnectStateRepo } from '@backend/domain/notification/repos/discord-connect-state.repo';
import { DiscordGuildRepo } from '@backend/domain/notification/repos/discord-guild.repo';
import { DiscordOAuthResultKinds } from '@backend/domain/notification/senders/discord-oauth';
import {
  createFakeDiscordOAuth,
  installedGuild,
  type FakeDiscordOAuth,
} from '@backend/domain/notification/testing/fake-discord-oauth';
import { seedWorkspace } from '@backend/domain/notification/testing/seed';
import { expectOne } from '@backend/infra/db/rows';
import { discordConnectStates, discordGuilds, users } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

const T0 = new Date('2026-09-25T12:00:00.000Z');

const stateOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get('state') ?? '';

describe('DiscordInstallService (pglite, fake OAuth)', () => {
  let t: TestDb;
  let clock: { now: Date };
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    t = await createTestDb();
    clock = { now: T0 };
    workspaceId = await seedWorkspace(t.db);
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
  });

  afterEach(async () => {
    await t.close();
  });

  const service = (oauth: FakeDiscordOAuth) =>
    new DiscordInstallService({
      states: new DiscordConnectStateRepo(t.db),
      guilds: new DiscordGuildRepo(t.db),
      oauth,
      now: () => clock.now,
    });

  const begin = async (install: DiscordInstallService) => {
    const { authorizeUrl } = await install.startInstall(userId, workspaceId);
    return stateOf(authorizeUrl);
  };

  it('issues a single-use state bound to the user and workspace, and redirects to Discord', async () => {
    const { authorizeUrl } = await service(createFakeDiscordOAuth()).startInstall(userId, workspaceId);

    const state = stateOf(authorizeUrl);
    expect(state.length).toBeGreaterThanOrEqual(43);
    const [row] = await t.db.select().from(discordConnectStates);
    expect(row).toMatchObject({
      state,
      userId,
      workspaceId,
      consumedAt: null,
      expiresAt: new Date(T0.getTime() + DISCORD_CONNECT_STATE_TTL_MS),
    });
  });

  it('a valid state binds the guild from the exchange response', async () => {
    const oauth = createFakeDiscordOAuth(installedGuild('9001', 'Acme HQ'));
    const install = service(oauth);
    const state = await begin(install);

    const result = await install.completeInstall(state, 'the-code', userId);

    expect(oauth.exchanged).toEqual(['the-code']);
    expect(result).toEqual({
      workspaceId,
      guild: { id: expect.any(String) as string, guildId: '9001', guildName: 'Acme HQ' },
    });
    const [guild] = await t.db.select().from(discordGuilds);
    expect(guild).toMatchObject({ workspaceId, guildId: '9001', guildName: 'Acme HQ', installedByUserId: userId });
    // The result is projected, not the row (the ext route has no `.output()`).
    expect(new Set(Object.keys(result.guild))).toEqual(new Set(['id', 'guildId', 'guildName']));
  });

  it('installing into the same guild again refreshes it instead of duplicating', async () => {
    const install = service(createFakeDiscordOAuth(installedGuild('9001', 'Old'), installedGuild('9001', 'New')));
    const first = await begin(install);
    await install.completeInstall(first, 'a', userId);
    const second = await begin(install);
    await install.completeInstall(second, 'b', userId);

    const guilds = await t.db.select().from(discordGuilds);
    expect(guilds.map(guild => guild.guildName)).toEqual(['New']);
  });

  it('rejects a consumed state (a second callback) without exchanging again', async () => {
    const oauth = createFakeDiscordOAuth(installedGuild('9001'));
    const install = service(oauth);
    const state = await begin(install);
    await install.completeInstall(state, 'code', userId);

    await expect(install.completeInstall(state, 'code', userId)).rejects.toBeInstanceOf(
      DiscordConnectStateInvalidError,
    );
    expect(oauth.exchanged).toHaveLength(1);
  });

  it('rejects an expired state', async () => {
    const oauth = createFakeDiscordOAuth(installedGuild('9001'));
    const install = service(oauth);
    const state = await begin(install);
    clock.now = new Date(T0.getTime() + DISCORD_CONNECT_STATE_TTL_MS + 1);

    await expect(install.completeInstall(state, 'code', userId)).rejects.toBeInstanceOf(
      DiscordConnectStateInvalidError,
    );
    expect(oauth.exchanged).toHaveLength(0);
    expect(await t.db.select().from(discordGuilds)).toHaveLength(0);
  });

  it("rejects another user's state and an unknown state", async () => {
    const oauth = createFakeDiscordOAuth(installedGuild('9001'));
    const install = service(oauth);
    const state = await begin(install);
    const otherUser = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;

    await expect(install.completeInstall(state, 'code', otherUser)).rejects.toBeInstanceOf(
      DiscordConnectStateInvalidError,
    );
    await expect(install.completeInstall('forged', 'code', userId)).rejects.toBeInstanceOf(
      DiscordConnectStateInvalidError,
    );
    expect(oauth.exchanged).toHaveLength(0);
    // The owner can still use it: a foreign attempt does not burn the state.
    await expect(install.completeInstall(state, 'code', userId)).resolves.toMatchObject({ workspaceId });
  });

  it('a failed exchange names the workspace and binds nothing', async () => {
    const install = service(
      createFakeDiscordOAuth({ kind: DiscordOAuthResultKinds.failed, reason: 'invalid_grant', transient: false }),
    );
    const state = await begin(install);

    const completing = install.completeInstall(state, 'code', userId);
    await expect(completing).rejects.toBeInstanceOf(DiscordInstallFailedError);
    await expect(completing).rejects.toMatchObject({ workspaceId, message: 'invalid_grant' });
    expect(await t.db.select().from(discordGuilds)).toHaveLength(0);
  });
});
