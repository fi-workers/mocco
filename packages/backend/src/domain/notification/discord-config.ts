// Binds the Discord leaf to env, for the composition roots. Pure: the roots pass
// `getEnv()` and the runtime's fetch/clock in. Returns undefined when the bot token
// is absent, so a deployment without Discord still boots; deliveries then wait
// (DeliveryService, "discord not configured").
import { DiscordApi } from '@backend/domain/notification/senders/discord';

import type { Env } from '@backend/infra/config/env';

export interface DiscordRuntime {
  fetch: typeof fetch;
  now: () => Date;
}

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
