import { describe, expect, it } from 'vitest';

import { DISCORD_BOT_PERMISSIONS, DiscordPermissions } from '@backend/domain/notification/senders/discord-constants';
import { DiscordOAuthResultKinds, createDiscordOAuth } from '@backend/domain/notification/senders/discord-oauth';
import { createFakeDiscordFetch, jsonResponse } from '@backend/domain/notification/testing/fake-discord-fetch';

import type { FakeReply } from '@backend/domain/notification/testing/fake-discord-fetch';

const CLIENT_ID = '1234567890';
const CLIENT_SECRET = 'client-secret-value';
const REDIRECT_URI = 'https://www.mocco.work/api/ext/discord/callback';

function oauth(...script: FakeReply[]) {
  const fake = createFakeDiscordFetch(...script);
  const client = createDiscordOAuth({
    fetch: fake.fetch,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    timeoutMs: 20,
  });
  return { client, requests: fake.requests };
}

const tokenResponse = {
  access_token: 'user-access-token',
  token_type: 'Bearer',
  expires_in: 604_800,
  refresh_token: 'user-refresh-token',
  scope: 'bot identify',
  guild: { id: '2909267986347357250', name: 'SomeTest', owner_id: '1', roles: [] },
};

describe('DISCORD_BOT_PERMISSIONS', () => {
  it('is View Channel | Send Messages | Embed Links | Read Message History', () => {
    expect(DISCORD_BOT_PERMISSIONS).toBe(1024 + 2048 + 16_384 + 65_536);
    expect(DISCORD_BOT_PERMISSIONS).toBe(
      DiscordPermissions.ViewChannel +
        DiscordPermissions.SendMessages +
        DiscordPermissions.EmbedLinks +
        DiscordPermissions.ReadMessageHistory,
    );
  });
});

describe('authorizeUrl', () => {
  it('asks for the bot and identify scopes with the bot permissions and the state', () => {
    const url = new URL(oauth().client.authorizeUrl('state-123'));
    expect(`${url.origin}${url.pathname}`).toBe('https://discord.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      scope: 'bot identify',
      permissions: '84992',
      integration_type: '0',
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      state: 'state-123',
    });
  });

  it('takes explicit permissions', () => {
    const url = new URL(oauth().client.authorizeUrl('s', DiscordPermissions.SendMessages));
    expect(url.searchParams.get('permissions')).toBe('2048');
  });

  it('never carries the client secret', () => {
    expect(oauth().client.authorizeUrl('s')).not.toContain(CLIENT_SECRET);
  });
});

describe('exchangeCode', () => {
  it('posts a form-encoded code grant with Basic client credentials and returns the guild', async () => {
    const { client, requests } = oauth(jsonResponse(200, tokenResponse));
    expect(await client.exchangeCode('the-code')).toEqual({
      kind: DiscordOAuthResultKinds.installed,
      guildId: '2909267986347357250',
      guildName: 'SomeTest',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('https://discord.com/api/v10/oauth2/token');
    expect(requests[0]?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- no toBase64 without the V8 flag
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    expect(requests[0]?.headers.get('authorization')).toBe(`Basic ${basic}`);
    expect(Object.fromEntries(new URLSearchParams(requests[0]?.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: REDIRECT_URI,
    });
  });

  it('fails when the response carries no guild', async () => {
    const { guild, ...withoutGuild } = tokenResponse;
    expect(guild).toBeDefined();
    const { client } = oauth(jsonResponse(200, withoutGuild));
    expect(await client.exchangeCode('the-code')).toMatchObject({
      kind: DiscordOAuthResultKinds.failed,
      transient: false,
    });
  });

  it('fails on an OAuth error response without leaking the secret', async () => {
    const { client } = oauth(
      jsonResponse(400, { error: 'invalid_grant', error_description: `Invalid "code" for ${CLIENT_SECRET}` }),
    );
    const result = await client.exchangeCode('stale-code');
    expect(result).toEqual({
      kind: DiscordOAuthResultKinds.failed,
      reason: 'Discord token exchange 400: Invalid "code" for [redacted]',
      status: 400,
      transient: false,
    });
  });

  it('marks a 5xx as transient', async () => {
    const { client } = oauth(new Response('oops', { status: 503 }));
    expect(await client.exchangeCode('the-code')).toEqual({
      kind: DiscordOAuthResultKinds.failed,
      reason: 'Discord token exchange 503',
      status: 503,
      transient: true,
    });
  });

  it('marks a timeout as transient', async () => {
    const { client } = oauth({ hang: true });
    expect(await client.exchangeCode('the-code')).toMatchObject({
      kind: DiscordOAuthResultKinds.failed,
      transient: true,
    });
  });

  it('never returns the access or refresh token', async () => {
    const { client } = oauth(jsonResponse(200, tokenResponse));
    const serialized = JSON.stringify(await client.exchangeCode('the-code'));
    expect(serialized).not.toContain('user-access-token');
    expect(serialized).not.toContain('user-refresh-token');
  });
});
