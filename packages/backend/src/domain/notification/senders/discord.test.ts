import { NeutralMessageLimits, Severities } from '@mocco/common/notification';
import { describe, expect, it } from 'vitest';

import { DiscordApi, DiscordResultKinds, renderEmbed, timedFetch } from '@backend/domain/notification/senders/discord';
import { DiscordChannelTypes, DiscordJsonErrorCodes } from '@backend/domain/notification/senders/discord-constants';
import {
  createFakeDiscordFetch,
  emptyResponse,
  jsonResponse,
} from '@backend/domain/notification/testing/fake-discord-fetch';

import type { FakeReply } from '@backend/domain/notification/testing/fake-discord-fetch';
import type { NeutralMessage, Severity } from '@mocco/common/notification';

const BOT_TOKEN = 'bot-token-MTk4NjIy.secret';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const CHANNEL = '111111111111111111';

const message: NeutralMessage = {
  title: 'TypeError in checkout',
  url: 'https://sentry.io/issues/1',
  description: 'Cannot read properties of undefined',
  severity: Severities.error,
  fields: [
    { name: 'Project', value: 'shop', inline: true },
    { name: 'Environment', value: 'production' },
  ],
  actor: { name: 'octocat', url: 'https://github.com/octocat', avatarUrl: 'https://avatars.example/octocat.png' },
  footer: 'Sentry',
};

function api(...script: FakeReply[]) {
  const fake = createFakeDiscordFetch(...script);
  const discord = new DiscordApi({ fetch: fake.fetch, botToken: BOT_TOKEN, now: () => NOW, timeoutMs: 20 });
  return { discord, requests: fake.requests };
}

const created = (headers: Record<string, string> = {}) => jsonResponse(200, { id: '999' }, headers);

function sentBody(requests: ReturnType<typeof api>['requests']) {
  const body = requests[0]?.body;
  if (body === undefined) {
    throw new Error('no request body recorded');
  }
  return JSON.parse(body) as { embeds: Record<string, unknown>[]; allowed_mentions: unknown };
}

/** Characters Discord counts against the 6000 embed total. */
function embedLength(embed: ReturnType<typeof renderEmbed>): number {
  return (
    embed.title.length +
    (embed.description?.length ?? 0) +
    embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0) +
    embed.footer.text.length +
    (embed.author?.name.length ?? 0)
  );
}

describe('renderEmbed', () => {
  const styles: [Severity, number, string][] = [
    [Severities.error, 0xc2_40_36, '🔴'],
    [Severities.warning, 0xe0_a0_3a, '🟠'],
    [Severities.success, 0x3b_a5_5d, '🟢'],
    [Severities.info, 0x58_65_f2, '🔵'],
  ];

  it.each(styles)('renders %s with its color and emoji prefix', (severity, color, emoji) => {
    const embed = renderEmbed({ ...message, severity }, NOW);
    expect(embed.color).toBe(color);
    expect(embed.title).toBe(`${emoji} TypeError in checkout`);
  });

  it('maps url, description, actor, fields, footer and the timestamp', () => {
    expect(renderEmbed(message, NOW)).toEqual({
      title: '🔴 TypeError in checkout',
      url: 'https://sentry.io/issues/1',
      description: 'Cannot read properties of undefined',
      color: 0xc2_40_36,
      timestamp: '2026-09-25T12:00:00.000Z',
      author: { name: 'octocat', url: 'https://github.com/octocat', icon_url: 'https://avatars.example/octocat.png' },
      fields: [
        { name: 'Project', value: 'shop', inline: true },
        { name: 'Environment', value: 'production', inline: false },
      ],
      footer: { text: 'Sentry' },
    });
  });

  it('omits the author without an actor', () => {
    const { actor, ...withoutActor } = message;
    expect(actor).toBeDefined();
    expect(renderEmbed(withoutActor, NOW).author).toBeUndefined();
  });

  it('keeps a maximal title inside the embed title cap after the prefix', () => {
    const { title } = renderEmbed({ ...message, title: 'x'.repeat(NeutralMessageLimits.title) }, NOW);
    expect(title.length).toBeLessThanOrEqual(NeutralMessageLimits.title);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps a short title plus a near-limit message inside the 6000 total', () => {
    const full: NeutralMessage = {
      title: 'Down',
      description: 'd'.repeat(NeutralMessageLimits.description),
      severity: Severities.error,
      fields: Array.from({ length: 3 }, (_, index) => ({ name: `f${index}`, value: 'v'.repeat(1024) })),
      footer: 'f'.repeat(NeutralMessageLimits.total - 4 - NeutralMessageLimits.description - 3 * (2 + 1024)),
    };
    const embed = renderEmbed(full, NOW);
    expect(embedLength(embed)).toBeLessThanOrEqual(NeutralMessageLimits.total);
    expect(embed.title).toBe('🔴 Down');
    expect(embed.description?.endsWith('…')).toBe(true);
  });

  it('drops the emoji prefix when there is no description to shorten', () => {
    const full: NeutralMessage = {
      title: 'Down',
      severity: Severities.error,
      fields: Array.from({ length: 5 }, (_, index) => ({ name: `f${index}`, value: 'v'.repeat(1024) })),
      footer: 'f'.repeat(NeutralMessageLimits.total - 4 - 5 * (2 + 1024)),
    };
    const embed = renderEmbed(full, NOW);
    expect(embedLength(embed)).toBeLessThanOrEqual(NeutralMessageLimits.total);
    expect(embed.title).toBe('Down');
  });

  // eslint-disable-next-line no-script-url -- the hostile input under test
  it.each(['javascript:alert(1)', 'ftp://files.example/x'])('drops a non-http(s) link: %s', link => {
    const embed = renderEmbed({ ...message, url: link, actor: { name: 'octocat', url: link, avatarUrl: link } }, NOW);
    expect(embed.url).toBeUndefined();
    expect(embed.author).toEqual({ name: 'octocat', url: undefined, icon_url: undefined });
  });
});

describe('DiscordApi.sendMessage', () => {
  it('posts one embed with the bot token and no parsed mentions', async () => {
    const { discord, requests } = api(created());
    await discord.sendMessage(CHANNEL, message);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
    expect(requests[0]?.headers.get('authorization')).toBe(`Bot ${BOT_TOKEN}`);
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(requests[0]?.headers.get('user-agent')).toBe('DiscordBot (https://www.mocco.club, 1)');
    const body = sentBody(requests);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.embeds).toEqual([renderEmbed(message, NOW)]);
  });

  it('sends an enforced nonce when given one, and none otherwise', async () => {
    const withNonce = api(created());
    await withNonce.discord.sendMessage(CHANNEL, message, { nonce: 'AAECAwQFBgcICQoLDA0ODw' });
    expect(sentBody(withNonce.requests)).toMatchObject({ nonce: 'AAECAwQFBgcICQoLDA0ODw', enforce_nonce: true });

    const without = api(created());
    await without.discord.sendMessage(CHANNEL, message);
    expect(sentBody(without.requests)).not.toHaveProperty('nonce');
    expect(sentBody(without.requests)).not.toHaveProperty('enforce_nonce');
  });

  it('returns the message id and the channel bucket', async () => {
    const { discord } = api(created({ 'X-RateLimit-Remaining': '4', 'X-RateLimit-Reset-After': '1.5' }));
    expect(await discord.sendMessage(CHANNEL, message)).toEqual({
      kind: DiscordResultKinds.sent,
      messageId: '999',
      bucket: { key: `channel:${CHANNEL}` },
    });
  });

  it('blocks the bucket until Reset-After once remaining hits 0', async () => {
    const { discord } = api(created({ 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset-After': '1.5' }));
    expect(await discord.sendMessage(CHANNEL, message)).toEqual({
      kind: DiscordResultKinds.sent,
      messageId: '999',
      bucket: { key: `channel:${CHANNEL}`, blockedUntil: new Date('2026-09-25T12:00:01.500Z') },
    });
  });

  it('falls back to X-RateLimit-Reset (epoch seconds) when Reset-After is missing', async () => {
    const reset = String(Date.parse('2026-09-25T12:00:04.000Z') / 1000);
    const { discord } = api(created({ 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': reset }));
    expect(await discord.sendMessage(CHANNEL, message)).toEqual({
      kind: DiscordResultKinds.sent,
      messageId: '999',
      bucket: { key: `channel:${CHANNEL}`, blockedUntil: new Date('2026-09-25T12:00:04.000Z') },
    });
  });

  it('reports no bucket when Discord sends no rate limit headers', async () => {
    const { discord } = api(created());
    expect(await discord.sendMessage(CHANNEL, message)).toEqual({
      kind: DiscordResultKinds.sent,
      messageId: '999',
      bucket: undefined,
    });
  });

  it('treats a 2xx without a message id as permanent, so a retry cannot post twice', async () => {
    const { discord } = api(jsonResponse(200, { unexpected: true }));
    expect(await discord.sendMessage(CHANNEL, message)).toMatchObject({
      kind: DiscordResultKinds.permanent,
      disableChannel: false,
      disableSender: false,
    });
  });

  describe('429', () => {
    it('retries a per-route limit at retry_after on the channel bucket', async () => {
      const { discord } = api(
        jsonResponse(429, { message: 'You are being rate limited.', retry_after: 0.75, global: false }),
      );
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.rate_limited,
        retryAt: new Date('2026-09-25T12:00:00.750Z'),
        global: false,
        shared: false,
        bucketKey: `channel:${CHANNEL}`,
      });
    });

    it('moves a global limit onto the global bucket', async () => {
      const { discord } = api(
        jsonResponse(
          429,
          { message: 'You are being rate limited.', retry_after: 2, global: true },
          { 'X-RateLimit-Global': 'true', 'X-RateLimit-Scope': 'global' },
        ),
      );
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.rate_limited,
        retryAt: new Date('2026-09-25T12:00:02.000Z'),
        global: true,
        shared: false,
        bucketKey: 'global',
      });
    });

    it('flags a shared-scope limit, which Discord does not count as invalid', async () => {
      const { discord } = api(
        jsonResponse(
          429,
          { message: 'You are being rate limited.', retry_after: 3 },
          { 'X-RateLimit-Scope': 'shared' },
        ),
      );
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.rate_limited,
        retryAt: new Date('2026-09-25T12:00:03.000Z'),
        global: false,
        shared: true,
        bucketKey: `channel:${CHANNEL}`,
      });
    });

    it('treats an HTML 429 without a scope header as a Cloudflare ban: global, at least 15 minutes', async () => {
      const { discord } = api(
        new Response('<html>banned</html>', {
          status: 429,
          headers: { 'content-type': 'text/html', 'Retry-After': '10' },
        }),
      );
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.rate_limited,
        retryAt: new Date('2026-09-25T12:15:00.000Z'),
        global: true,
        shared: false,
        bucketKey: 'global',
      });
    });

    it('keeps a longer Cloudflare Retry-After', async () => {
      const { discord } = api(new Response('<html>banned</html>', { status: 429, headers: { 'Retry-After': '3600' } }));
      expect(await discord.sendMessage(CHANNEL, message)).toMatchObject({
        retryAt: new Date('2026-09-25T13:00:00.000Z'),
        global: true,
      });
    });

    it('waits a conservative default for a scoped 429 that says nothing about how long', async () => {
      const { discord } = api(emptyResponse(429, { 'X-RateLimit-Scope': 'user' }));
      expect(await discord.sendMessage(CHANNEL, message)).toMatchObject({
        kind: DiscordResultKinds.rate_limited,
        retryAt: new Date('2026-09-25T12:01:00.000Z'),
        global: false,
        bucketKey: `channel:${CHANNEL}`,
      });
    });
  });

  describe('permanent failures', () => {
    it('disables the whole sender on 401', async () => {
      const { discord } = api(jsonResponse(401, { message: '401: Unauthorized', code: 0 }));
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.permanent,
        reason: 'Discord 401 (code 0): 401: Unauthorized',
        code: 0,
        disableChannel: false,
        disableSender: true,
      });
    });

    const channelErrors: [number, number, string][] = [
      [403, DiscordJsonErrorCodes.MissingAccess, 'Missing Access'],
      [403, DiscordJsonErrorCodes.MissingPermissions, 'Missing Permissions'],
      [404, DiscordJsonErrorCodes.UnknownChannel, 'Unknown Channel'],
      [404, DiscordJsonErrorCodes.UnknownGuild, 'Unknown Guild'],
    ];

    it.each(channelErrors)('disables the channel on %i with code %i', async (status, code, text) => {
      const { discord } = api(jsonResponse(status, { message: text, code }));
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.permanent,
        reason: `Discord ${status} (code ${code}): ${text}`,
        code,
        disableChannel: true,
        disableSender: false,
      });
    });

    const senderLevel: [string, Response][] = [
      ['a bare 403', emptyResponse(403)],
      ['a bare 404', emptyResponse(404)],
      ['a 403 with code 0', jsonResponse(403, { message: 'Forbidden', code: 0 })],
      ['a 404 with code 0', jsonResponse(404, { message: '404: Not Found', code: 0 })],
      [
        'a 403 with code 40333',
        jsonResponse(403, { message: 'internal network error', code: DiscordJsonErrorCodes.CloudflareBlocked }),
      ],
    ];

    it.each(senderLevel)('disables the sender, not the channel, on %s', async (_label, response) => {
      const { discord } = api(response);
      expect(await discord.sendMessage(CHANNEL, message)).toMatchObject({
        kind: DiscordResultKinds.permanent,
        disableChannel: false,
        disableSender: true,
      });
    });

    it('disables the channel on a disabling code under another status', async () => {
      const { discord } = api(
        jsonResponse(400, { message: 'Missing Access', code: DiscordJsonErrorCodes.MissingAccess }),
      );
      expect(await discord.sendMessage(CHANNEL, message)).toMatchObject({
        kind: DiscordResultKinds.permanent,
        disableChannel: true,
      });
    });

    it('fails an invalid form body without disabling anything', async () => {
      const { discord } = api(
        jsonResponse(400, {
          message: 'Invalid Form Body',
          code: DiscordJsonErrorCodes.InvalidFormBody,
          errors: { embeds: {} },
        }),
      );
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.permanent,
        reason: 'Discord 400 (code 50035): Invalid Form Body',
        code: DiscordJsonErrorCodes.InvalidFormBody,
        disableChannel: false,
        disableSender: false,
      });
    });
  });

  describe('transient failures', () => {
    it('retries a 5xx', async () => {
      const { discord } = api(new Response('upstream error', { status: 502 }));
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.transient,
        reason: 'Discord 502',
        status: 502,
      });
    });

    it('retries a 500 with a JSON body', async () => {
      const { discord } = api(jsonResponse(500, { message: 'Internal Server Error', code: 0 }));
      expect(await discord.sendMessage(CHANNEL, message)).toMatchObject({
        kind: DiscordResultKinds.transient,
        status: 500,
      });
    });

    it('aborts and retries a request that never answers', async () => {
      const { discord } = api({ hang: true });
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.transient,
        reason: 'Discord did not answer within 20 ms',
      });
    });

    it('retries a network error without echoing its message', async () => {
      const { discord } = api({ throws: new TypeError(`fetch failed: Bot ${BOT_TOKEN}`) });
      expect(await discord.sendMessage(CHANNEL, message)).toEqual({
        kind: DiscordResultKinds.transient,
        reason: 'network error reaching Discord (TypeError)',
      });
    });
  });

  it('never puts the bot token into a result', async () => {
    const echo = `Bot ${BOT_TOKEN} is not valid`;
    const { discord } = api(
      jsonResponse(401, { message: echo }),
      jsonResponse(403, { message: echo, code: DiscordJsonErrorCodes.MissingAccess }),
      jsonResponse(400, { message: echo }),
      jsonResponse(503, { message: echo }),
      jsonResponse(429, { message: echo, retry_after: 1 }),
      { throws: new Error(echo) },
      { hang: true },
    );
    const results = [];
    for (let index = 0; index < 7; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- the fake replies in script order
      results.push(await discord.sendMessage(CHANNEL, message));
    }
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).toContain('[redacted]');
  });
});

describe('timedFetch', () => {
  it('stops when the caller aborts, before the timeout', async () => {
    const fake = createFakeDiscordFetch({ hang: true });
    const caller = new AbortController();
    const pending = timedFetch(fake.fetch, 'https://discord.com/api/v10/x', { signal: caller.signal }, 60_000);
    caller.abort();
    expect(await pending).toEqual({ kind: DiscordResultKinds.transient, reason: 'request to Discord was cancelled' });
  });
});

describe('DiscordApi.deleteMessage', () => {
  it('deletes the message and reports the bucket', async () => {
    const { discord, requests } = api(emptyResponse(204, { 'X-RateLimit-Remaining': '4' }));
    expect(await discord.deleteMessage(CHANNEL, '999')).toEqual({
      kind: DiscordResultKinds.deleted,
      bucket: { key: `channel:${CHANNEL}` },
    });
    expect(requests[0]?.method).toBe('DELETE');
    expect(requests[0]?.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages/999`);
    expect(requests[0]?.body).toBeUndefined();
    expect(requests[0]?.headers.get('content-type')).toBeNull();
  });

  it('does not disable the channel when the message is already gone', async () => {
    const { discord } = api(
      jsonResponse(404, { message: 'Unknown Message', code: DiscordJsonErrorCodes.UnknownMessage }),
    );
    expect(await discord.deleteMessage(CHANNEL, '999')).toMatchObject({
      kind: DiscordResultKinds.permanent,
      code: DiscordJsonErrorCodes.UnknownMessage,
      disableChannel: false,
    });
  });

  it('classifies failures like a send', async () => {
    const { discord } = api(
      jsonResponse(403, { message: 'Missing Access', code: DiscordJsonErrorCodes.MissingAccess }),
    );
    expect(await discord.deleteMessage(CHANNEL, '999')).toMatchObject({ disableChannel: true });
  });
});

describe('DiscordApi.getBotMember', () => {
  it('reads the bot id once, then its guild membership', async () => {
    const { discord, requests } = api(
      jsonResponse(200, { id: '4242' }),
      jsonResponse(200, { joined_at: '2026-09-20T10:00:00.000000+00:00' }),
      jsonResponse(200, { joined_at: null }),
    );

    expect(await discord.getBotMember('900')).toEqual({
      kind: DiscordResultKinds.member,
      joinedAt: new Date('2026-09-20T10:00:00.000Z'),
    });
    expect(await discord.getBotMember('901')).toEqual({ kind: DiscordResultKinds.member, joinedAt: null });
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      '/api/v10/users/@me',
      '/api/v10/guilds/900/members/4242',
      '/api/v10/guilds/901/members/4242',
    ]);
  });

  it('reports a bot that is not in the guild as a permanent failure with its code', async () => {
    const { discord } = api(
      jsonResponse(200, { id: '4242' }),
      jsonResponse(404, { message: 'Unknown Member', code: DiscordJsonErrorCodes.UnknownMember }),
    );
    expect(await discord.getBotMember('900')).toMatchObject({
      kind: DiscordResultKinds.permanent,
      code: DiscordJsonErrorCodes.UnknownMember,
    });
  });
});

describe('DiscordApi.listTextChannels', () => {
  const GUILD = '222222222222222222';

  it('keeps text and announcement channels, sorted by position', async () => {
    const { discord, requests } = api(
      jsonResponse(200, [
        { id: '5', type: DiscordChannelTypes.GuildText, name: 'deploys', position: 3 },
        { id: '1', type: 4, name: 'Category', position: 0 },
        { id: '2', type: DiscordChannelTypes.GuildAnnouncement, name: 'announcements', position: 1 },
        { id: '3', type: 2, name: 'Voice', position: 2 },
        { id: '4', type: DiscordChannelTypes.GuildText, name: 'general', position: 0 },
        { id: '6', type: 15, name: 'forum', position: 4 },
      ]),
    );
    expect(await discord.listTextChannels(GUILD)).toEqual({
      kind: DiscordResultKinds.listed,
      channels: [
        { id: '4', name: 'general', type: DiscordChannelTypes.GuildText },
        { id: '2', name: 'announcements', type: DiscordChannelTypes.GuildAnnouncement },
        { id: '5', name: 'deploys', type: DiscordChannelTypes.GuildText },
      ],
    });
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/channels`);
  });

  it('reports an unexpected body as transient', async () => {
    const { discord } = api(jsonResponse(200, { not: 'a list' }));
    expect(await discord.listTextChannels(GUILD)).toMatchObject({ kind: DiscordResultKinds.transient });
  });

  it('reports a missing guild as a permanent failure', async () => {
    const { discord } = api(jsonResponse(404, { message: 'Unknown Guild', code: DiscordJsonErrorCodes.UnknownGuild }));
    expect(await discord.listTextChannels(GUILD)).toMatchObject({
      kind: DiscordResultKinds.permanent,
      code: DiscordJsonErrorCodes.UnknownGuild,
    });
  });

  it('keys a per-route 429 on no pacing bucket', async () => {
    const { discord } = api(jsonResponse(429, { message: 'rate limited', retry_after: 1, global: false }));
    expect(await discord.listTextChannels(GUILD)).toMatchObject({
      kind: DiscordResultKinds.rate_limited,
      bucketKey: undefined,
    });
  });
});
