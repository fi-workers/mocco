// A scripted DiscordOAuth port for install tests (test infra, never imported by
// production code). It records every code it was asked to exchange and answers
// with the next scripted result.
import {
  DiscordOAuthResultKinds,
  type DiscordOAuth,
  type DiscordOAuthResult,
} from '@backend/domain/notification/senders/discord-oauth';

export const FAKE_AUTHORIZE_BASE = 'https://discord.test/oauth2/authorize';

export function installedGuild(guildId: string, guildName = 'Acme'): DiscordOAuthResult {
  return { kind: DiscordOAuthResultKinds.installed, guildId, guildName };
}

export type FakeDiscordOAuth = DiscordOAuth & { exchanged: string[] };

export function createFakeDiscordOAuth(...script: DiscordOAuthResult[]): FakeDiscordOAuth {
  const results = [...script];
  const exchanged: string[] = [];
  return {
    exchanged,
    authorizeUrl: state => `${FAKE_AUTHORIZE_BASE}?state=${encodeURIComponent(state)}`,
    async exchangeCode(code) {
      exchanged.push(code);
      const result = results.shift();
      if (result === undefined) {
        throw new Error('fake Discord OAuth: no scripted result left');
      }
      return await Promise.resolve(result);
    },
  };
}
