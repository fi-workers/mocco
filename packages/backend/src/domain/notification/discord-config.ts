// Binds the Discord leaf to env, for the composition roots. Pure: the roots pass
// `getEnv()` and the runtime's fetch/clock in. Each factory returns undefined when its
// env is absent, so a deployment without Discord still boots; deliveries then wait
// (DeliveryService, "discord not configured") and the install routes answer 503.
import { DiscordApi } from '@backend/domain/notification/senders/discord';
import { createDiscordOAuth, type DiscordOAuth } from '@backend/domain/notification/senders/discord-oauth';

import type { Env } from '@backend/infra/config/env';

export interface DiscordRuntime {
  fetch: typeof fetch;
  now: () => Date;
}

/** Where Discord sends the installing user back to (`GET /api/ext/discord/callback`). */
export const DISCORD_CALLBACK_PATH = '/api/ext/discord/callback';

/** The Discord REST client with the Mocco bot token, or undefined without DISCORD_BOT_TOKEN. */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "not configured" answer
export function createDiscordApiFromEnv(
  env: Pick<Env, 'DISCORD_BOT_TOKEN'>,
  runtime: DiscordRuntime,
): DiscordApi | undefined {
  if (env.DISCORD_BOT_TOKEN === undefined) {
    return undefined;
  }
  return new DiscordApi({ fetch: runtime.fetch, botToken: env.DISCORD_BOT_TOKEN, now: runtime.now });
}

/**
 * The bot install OAuth client, or undefined unless the client pair and the bot token
 * are all set (an install without a token could bind guilds it can never post to).
 */
// eslint-disable-next-line sonarjs/function-return-type -- undefined is the "not configured" answer
export function createDiscordOAuthFromEnv(
  env: Pick<Env, 'DISCORD_CLIENT_ID' | 'DISCORD_CLIENT_SECRET' | 'DISCORD_BOT_TOKEN'>,
  runtime: { fetch: typeof fetch; appOrigin: string },
): DiscordOAuth | undefined {
  if (
    env.DISCORD_CLIENT_ID === undefined ||
    env.DISCORD_CLIENT_SECRET === undefined ||
    env.DISCORD_BOT_TOKEN === undefined
  ) {
    return undefined;
  }
  return createDiscordOAuth({
    fetch: runtime.fetch,
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    redirectUri: `${runtime.appOrigin}${DISCORD_CALLBACK_PATH}`,
  });
}
