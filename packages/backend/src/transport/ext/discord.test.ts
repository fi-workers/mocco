import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { DiscordInstallService } from '@backend/domain/notification/DiscordInstallService';
import { DiscordConnectStateRepo } from '@backend/domain/notification/repos/discord-connect-state.repo';
import { DiscordGuildRepo } from '@backend/domain/notification/repos/discord-guild.repo';
import { DiscordOAuthResultKinds } from '@backend/domain/notification/senders/discord-oauth';
import {
  createFakeDiscordOAuth,
  FAKE_AUTHORIZE_BASE,
  installedGuild,
  type FakeDiscordOAuth,
} from '@backend/domain/notification/testing/fake-discord-oauth';
import { discordConnectStates, discordGuilds, members } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createDiscordInstallRoutes } from '@backend/transport/ext/discord';

const signUp = async (auth: AuthService, email: string) => {
  const response = await auth.handler(
    new Request('https://local.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'fixture-password-1', name: 'fixture-user' }),
    }),
  );
  return new Headers({ cookie: response.headers.get('set-cookie') ?? '' });
};

const location = (response: Response) => response.headers.get('location') ?? '';

const statusOf = async (response: Promise<Response> | Response) => {
  const { status } = await response;
  return status;
};

describe('ext Discord install routes (pglite, fake OAuth)', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  const routes = (oauth: FakeDiscordOAuth | undefined) =>
    createDiscordInstallRoutes({
      auth,
      discord:
        oauth === undefined
          ? undefined
          : {
              install: new DiscordInstallService({
                states: new DiscordConnectStateRepo(t.db),
                guilds: new DiscordGuildRepo(t.db),
                oauth,
                now: () => new Date(),
              }),
              workspace,
            },
    });

  const ownerOfWorkspace = async (email: string) => {
    const headers = await signUp(auth, email);
    const created = await workspace.create(headers, { name: 'W' });
    return { headers, workspaceId: created?.id ?? '' };
  };

  /** Start an install and return the state Discord would echo back. */
  const startInstall = async (app: ReturnType<typeof routes>, headers: Headers, workspaceId: string) => {
    const response = await app.request(`/discord/install?workspaceId=${workspaceId}`, { headers });
    expect(response.status).toBe(302);
    return new URL(location(response)).searchParams.get('state') ?? '';
  };

  it('503s both routes when Discord is not configured', async () => {
    const app = routes(undefined);
    expect(await statusOf(app.request('/discord/install?workspaceId=x'))).toBe(503);
    expect(await statusOf(app.request('/discord/callback?code=c&state=s'))).toBe(503);
  });

  it('sends a signed-out user to sign in, and 400s a bad workspace id', async () => {
    const app = routes(createFakeDiscordOAuth());
    const signedOut = await app.request('/discord/install?workspaceId=00000000-0000-4000-8000-000000000000');
    expect(signedOut.status).toBe(302);
    expect(location(signedOut)).toBe('/auth/sign-in');

    const { headers } = await ownerOfWorkspace('a@example.com');
    expect(await statusOf(app.request('/discord/install?workspaceId=nope', { headers }))).toBe(400);
  });

  /** Add `email` to the workspace as a plain member (the org plugin's default role). */
  const plainMember = async (workspaceId: string, email: string) => {
    const headers = await signUp(auth, email);
    const session = await auth.getSession(headers);
    await t.db.insert(members).values({ organizationId: workspaceId, userId: session?.user.id ?? '', role: 'member' });
    return headers;
  };

  it('403s a plain member on install, and issues no state', async () => {
    const app = routes(createFakeDiscordOAuth());
    const { workspaceId } = await ownerOfWorkspace('owner@example.com');
    const member = await plainMember(workspaceId, 'member@example.com');

    const response = await app.request(`/discord/install?workspaceId=${workspaceId}`, { headers: member });

    expect(response.status).toBe(403);
    expect(await t.db.select().from(discordConnectStates)).toHaveLength(0);
  });

  it('refuses the callback when the installer is no longer an owner or admin, without exchanging', async () => {
    const oauth = createFakeDiscordOAuth(installedGuild('9001'));
    const app = routes(oauth);
    const { headers, workspaceId } = await ownerOfWorkspace('owner@example.com');
    const state = await startInstall(app, headers, workspaceId);
    await t.db.update(members).set({ role: 'member' }).where(eq(members.organizationId, workspaceId));

    const response = await app.request(`/discord/callback?code=c&state=${state}`, { headers });

    expect(location(response)).toBe('/workspaces?connect_error=1');
    expect(oauth.exchanged).toEqual([]);
    expect(await t.db.select().from(discordGuilds)).toHaveLength(0);
  });

  it("404s a workspace the user isn't a member of, and issues no state", async () => {
    const app = routes(createFakeDiscordOAuth());
    const { workspaceId } = await ownerOfWorkspace('owner@example.com');
    const stranger = await signUp(auth, 'stranger@example.com');

    const response = await app.request(`/discord/install?workspaceId=${workspaceId}`, { headers: stranger });

    expect(response.status).toBe(404);
    expect(await t.db.select().from(discordConnectStates)).toHaveLength(0);
  });

  it('redirects a member to Discord, then binds the guild from the exchange and lands on the channels tab', async () => {
    const oauth = createFakeDiscordOAuth(installedGuild('9001', 'Acme HQ'));
    const app = routes(oauth);
    const { headers, workspaceId } = await ownerOfWorkspace('owner@example.com');

    const state = await startInstall(app, headers, workspaceId);
    // The `guild_id` hint in the query is ignored: the exchange says 9001.
    const callback = await app.request(`/discord/callback?code=the-code&state=${state}&guild_id=1234`, { headers });

    expect(callback.status).toBe(302);
    expect(location(callback)).toBe(`/workspaces/${workspaceId}/notifications?tab=channels`);
    expect(oauth.exchanged).toEqual(['the-code']);
    const guilds = await t.db.select().from(discordGuilds);
    expect(guilds.map(guild => [guild.workspaceId, guild.guildId])).toEqual([[workspaceId, '9001']]);
  });

  it('redirects with connect_error for a replayed, forged or foreign state, or a cancelled install', async () => {
    const oauth = createFakeDiscordOAuth(installedGuild('9001'));
    const app = routes(oauth);
    const { headers, workspaceId } = await ownerOfWorkspace('owner@example.com');
    const state = await startInstall(app, headers, workspaceId);
    const other = await signUp(auth, 'other@example.com');

    const foreign = await app.request(`/discord/callback?code=c&state=${state}`, { headers: other });
    const forged = await app.request('/discord/callback?code=c&state=forged', { headers });
    const cancelled = await app.request(`/discord/callback?error=access_denied&state=${state}`, { headers });
    await app.request(`/discord/callback?code=c&state=${state}`, { headers });
    const replayed = await app.request(`/discord/callback?code=c&state=${state}`, { headers });

    expect([foreign, forged, cancelled, replayed].map(response => [response.status, location(response)])).toEqual(
      Array.from({ length: 4 }, () => [302, '/workspaces?connect_error=1']),
    );
    expect(oauth.exchanged).toEqual(['c']);
    expect(await t.db.select().from(discordGuilds)).toHaveLength(1);
  });

  it('lands on the channels tab with connect_error when the exchange fails', async () => {
    const app = routes(
      createFakeDiscordOAuth({ kind: DiscordOAuthResultKinds.failed, reason: 'invalid_grant', transient: false }),
    );
    const { headers, workspaceId } = await ownerOfWorkspace('owner@example.com');
    const state = await startInstall(app, headers, workspaceId);

    const response = await app.request(`/discord/callback?code=c&state=${state}`, { headers });

    expect(location(response)).toBe(`/workspaces/${workspaceId}/notifications?tab=channels&connect_error=1`);
    expect(await t.db.select().from(discordGuilds)).toHaveLength(0);
  });

  it('points the install redirect at Discord with the state', async () => {
    const app = routes(createFakeDiscordOAuth());
    const { headers, workspaceId } = await ownerOfWorkspace('owner@example.com');

    const response = await app.request(`/discord/install?workspaceId=${workspaceId}`, { headers });

    expect(location(response).startsWith(`${FAKE_AUTHORIZE_BASE}?state=`)).toBe(true);
  });
});
