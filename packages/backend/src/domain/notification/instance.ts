// Production composition root for the notification domain's request-path services
// (the tRPC router and the Discord install routes). Lazy so builds don't need env at
// import. The fan-out and the delivery job are composed elsewhere: the fan-out in
// createEventBus (domain/events/subscriptions.ts), the job in runtime/jobs.ts.
import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { InboundReceiptRepo } from '@backend/domain/inbound/repos/inbound-receipt.repo';
import { InboundSourceRepo } from '@backend/domain/inbound/repos/inbound-source.repo';
import { ActivityService } from '@backend/domain/notification/ActivityService';
import { ChannelService } from '@backend/domain/notification/ChannelService';
import { createDiscordApiFromEnv, createDiscordOAuthFromEnv } from '@backend/domain/notification/discord-config';
import { DiscordInstallService } from '@backend/domain/notification/DiscordInstallService';
import { ChannelRepo } from '@backend/domain/notification/repos/channel.repo';
import { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import { DiscordConnectStateRepo } from '@backend/domain/notification/repos/discord-connect-state.repo';
import { DiscordGuildRepo } from '@backend/domain/notification/repos/discord-guild.repo';
import { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import { RuleRepo } from '@backend/domain/notification/repos/rule.repo';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

export interface Notification {
  /** Always present: reads work without Discord; Discord calls throw DiscordNotConfiguredError. */
  channels: ChannelService;
  /** The bot install; undefined unless DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_BOT_TOKEN are set. */
  install: DiscordInstallService | undefined;
  /** The activity trace; a read model over receipts, events and deliveries. */
  activity: ActivityService;
}

const state: { notification?: Notification } = {};

export function getNotification(): Notification {
  if (!state.notification) {
    const db = getDb();
    const env = getEnv();
    const now = () => new Date();
    const appOrigin = resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL });
    const guilds = new DiscordGuildRepo(db);
    const channels = new ChannelRepo(db);
    const rules = new RuleRepo(db);
    const deliveries = new DeliveryRepo(db);
    const oauth = createDiscordOAuthFromEnv(env, { fetch, appOrigin });
    state.notification = {
      channels: new ChannelService({
        guilds,
        channels,
        rules,
        deliveries,
        rateLimits: new DiscordRateLimitRepo(db),
        discord: createDiscordApiFromEnv(env, { fetch, now }),
        installAvailable: oauth !== undefined,
        now,
      }),
      activity: new ActivityService({
        receipts: new InboundReceiptRepo(db),
        sources: new InboundSourceRepo(db),
        channels,
        rules,
        deliveries,
      }),
      install:
        oauth === undefined
          ? undefined
          : new DiscordInstallService({ states: new DiscordConnectStateRepo(db), guilds, oauth, now }),
    };
  }
  return state.notification;
}
