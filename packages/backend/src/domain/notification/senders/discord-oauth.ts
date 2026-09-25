import { z } from 'zod';

import { parseJson, redact, timedFetch, truncate } from '@backend/domain/notification/senders/discord';
import {
  DISCORD_API_BASE,
  DISCORD_AUTHORIZE_URL,
  DISCORD_BOT_PERMISSIONS,
  DISCORD_BOT_SCOPES,
  DISCORD_DEFAULT_TIMEOUT_MS,
  DISCORD_GUILD_INSTALL,
  DISCORD_REASON_MAX,
  DISCORD_USER_AGENT,
} from '@backend/domain/notification/senders/discord-constants';

// The Discord bot install (OAuth2 authorization code grant with the `bot` scope).
// `DiscordOAuth` is the port the install service depends on, so its tests use a
// fake; `createDiscordOAuth` is the real binding. The HTTP call itself goes
// through `timedFetch` in senders/discord.ts, the one Discord transport.

export const DiscordOAuthResultKinds = {
  installed: 'installed',
  failed: 'failed',
} as const;

export type DiscordOAuthResult =
  | { kind: typeof DiscordOAuthResultKinds.installed; guildId: string; guildName: string }
  | {
      kind: typeof DiscordOAuthResultKinds.failed;
      reason: string;
      status?: number;
      /** A timeout, network error, 429 or 5xx: the user may simply try the install again. */
      transient: boolean;
    };

export interface DiscordOAuth {
  /** Where to send the installing user; `state` comes back on the callback untouched. */
  authorizeUrl(state: string, permissions?: number): string;
  /** Exchange the callback `code`; the guild comes from Discord's token response only. */
  exchangeCode(code: string): Promise<DiscordOAuthResult>;
}

export interface DiscordOAuthDeps {
  fetch: typeof fetch;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  timeoutMs?: number;
}

/** The token response of a `bot`-scope grant carries the guild the bot joined. */
const tokenResponseSchema = z.object({
  guild: z.object({ id: z.string().min(1), name: z.string() }).optional(),
});

const oauthErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

export function createDiscordOAuth(deps: DiscordOAuthDeps): DiscordOAuth {
  const timeoutMs = deps.timeoutMs ?? DISCORD_DEFAULT_TIMEOUT_MS;
  const secrets = [deps.clientSecret];
  const failed = (reason: string, retry: { transient: boolean; status?: number }): DiscordOAuthResult => ({
    kind: DiscordOAuthResultKinds.failed,
    reason: truncate(redact(reason, secrets), DISCORD_REASON_MAX),
    ...retry,
  });

  return {
    authorizeUrl(state, permissions = DISCORD_BOT_PERMISSIONS) {
      const url = new URL(DISCORD_AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: deps.clientId,
        scope: DISCORD_BOT_SCOPES,
        permissions: String(permissions),
        integration_type: String(DISCORD_GUILD_INSTALL),
        response_type: 'code',
        redirect_uri: deps.redirectUri,
        state,
      }).toString();
      return url.href;
    },

    async exchangeCode(code) {
      // Buffer is the only base64 encoder available without the V8 --js-base-64 flag.
      // eslint-disable-next-line unicorn/prefer-uint8array-base64
      const basic = Buffer.from(`${deps.clientId}:${deps.clientSecret}`).toString('base64');
      const outcome = await timedFetch(
        deps.fetch,
        `${DISCORD_API_BASE}/oauth2/token`,
        {
          method: 'POST',
          headers: {
            // https://docs.discord.com/developers/topics/oauth2: client credentials go
            // in HTTP Basic auth; the body must be form-encoded (JSON is rejected).
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': DISCORD_USER_AGENT,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: deps.redirectUri,
          }).toString(),
        },
        timeoutMs,
      );
      if (outcome.kind !== 'response') {
        return failed(outcome.reason, { transient: true });
      }
      const { response, text } = outcome;
      const json = parseJson(text);
      if (!response.ok) {
        const parsed = oauthErrorSchema.safeParse(json);
        const detail = parsed.success ? (parsed.data.error_description ?? parsed.data.error) : undefined;
        const suffix = detail === undefined ? '' : `: ${detail}`;
        return failed(`Discord token exchange ${response.status}${suffix}`, {
          transient: response.status >= 500 || response.status === 429,
          status: response.status,
        });
      }
      const parsed = tokenResponseSchema.safeParse(json);
      if (!parsed.success) {
        return failed('Discord token exchange returned an unexpected response', {
          transient: false,
          status: response.status,
        });
      }
      if (parsed.data.guild === undefined) {
        return failed('Discord token exchange did not include a guild (was the bot scope granted?)', {
          transient: false,
        });
      }
      return {
        kind: DiscordOAuthResultKinds.installed,
        guildId: parsed.data.guild.id,
        guildName: parsed.data.guild.name,
      };
    },
  };
}
