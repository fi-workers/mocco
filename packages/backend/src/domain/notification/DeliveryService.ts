import { ChannelStatuses, DeliveryStatuses } from '@mocco/common/notification';

import { RetryAt } from '@backend/domain/jobs/retry-at';
import { DeliveryPolicy, DeliveryReasons } from '@backend/domain/notification/constants';
import { TransientDeliveryError } from '@backend/domain/notification/errors';
import { DiscordResultKinds } from '@backend/domain/notification/senders/discord';
import { DISCORD_GLOBAL_BUCKET, discordChannelBucket } from '@backend/domain/notification/senders/discord-constants';

import type { ChannelRepo, ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import type { DeliveryRepo, DeliveryRow } from '@backend/domain/notification/repos/delivery.repo';
import type { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import type { DiscordApi, DiscordFailure, DiscordSent } from '@backend/domain/notification/senders/discord';

/** The part of the Discord client a delivery needs. */
export type DiscordMessenger = Pick<DiscordApi, 'sendMessage'>;

export interface DeliveryServiceDeps {
  deliveries: DeliveryRepo;
  channels: ChannelRepo;
  rateLimits: DiscordRateLimitRepo;
  /** Undefined when this deployment has no DISCORD_BOT_TOKEN. */
  discord: DiscordMessenger | undefined;
}

/** Which run of the delivery job this is (from the job context). */
export interface DeliveryAttempt {
  /** 1 on the first attempt; the job's `max_attempts` is `DeliveryPolicy.maxAttempts`. */
  attempt: number;
  now: Date;
}

/**
 * Runs one `notification.deliver` job: sends a queued delivery to its Discord channel
 * and settles it from the answer (relay design §6). Pacing is shared across runners
 * through `mocco_discord_rate_limits`; a delivery that must wait throws `RetryAt`.
 * Idempotent: a settled delivery (sent, failed, suppressed) is a no-op.
 */
export class DeliveryService {
  constructor(private readonly deps: DeliveryServiceDeps) {}

  /**
   * Whether the delivery may send now. Throws RetryAt while a Discord bucket is blocked
   * or the workspace is over its per-minute share; false when that wait was the job's
   * last attempt (the delivery is failed instead).
   */
  private async hasCapacity(delivery: DeliveryRow, channel: ChannelRow, attempt: DeliveryAttempt): Promise<boolean> {
    const buckets = [discordChannelBucket(channel.externalId), DISCORD_GLOBAL_BUCKET];
    const blockedUntil = await this.deps.rateLimits.blockedUntil(buckets, attempt.now);
    if (blockedUntil !== undefined) {
      await this.retryLater(delivery, attempt, blockedUntil, DeliveryReasons.rateLimited);
      return false;
    }
    const since = new Date(attempt.now.getTime() - DeliveryPolicy.fairnessWindowMs);
    const { sent, oldest } = await this.deps.deliveries.sentSince(delivery.workspaceId, since);
    if (sent >= DeliveryPolicy.workspacePerMinute) {
      // A slot frees when the oldest send of the window ages out of it.
      const freed = (oldest ?? attempt.now).getTime() + DeliveryPolicy.fairnessWindowMs;
      const at = new Date(Math.max(freed, attempt.now.getTime() + DeliveryPolicy.fairnessMinRetryMs));
      await this.retryLater(delivery, attempt, at, DeliveryReasons.workspaceLimit);
      return false;
    }
    return true;
  }

  private async sent(delivery: DeliveryRow, result: DiscordSent, now: Date): Promise<void> {
    await this.settle(delivery, {
      status: DeliveryStatuses.sent,
      externalMessageId: result.messageId,
      sentAt: now,
      error: null,
      nextAttemptAt: null,
    });
    // The bucket is exhausted: the next send to this channel waits for its reset.
    if (result.bucket?.blockedUntil !== undefined) {
      await this.deps.rateLimits.block(result.bucket.key, result.bucket.blockedUntil);
    }
  }

  private async failed(
    delivery: DeliveryRow,
    channel: ChannelRow,
    result: DiscordFailure,
    attempt: DeliveryAttempt,
  ): Promise<void> {
    switch (result.kind) {
      case DiscordResultKinds.rate_limited: {
        await this.deps.rateLimits.block(result.bucketKey ?? discordChannelBucket(channel.externalId), result.retryAt);
        await this.retryLater(delivery, attempt, result.retryAt, DeliveryReasons.rateLimited, 429);
        return;
      }
      case DiscordResultKinds.permanent: {
        if (result.disableChannel) {
          // The bot cannot reach this channel any more: stop sending to it (relay design §6).
          await this.deps.channels.disable(channel.workspaceId, channel.id, result.reason);
          await this.settle(delivery, { status: DeliveryStatuses.failed, error: result.reason });
          return;
        }
        if (result.disableSender) {
          // The bot token or our egress is rejected: an operator problem, not the
          // tenant's. Pause every send and keep the delivery queued.
          const until = new Date(attempt.now.getTime() + DeliveryPolicy.senderPauseMs);
          console.error(`[notification] DISCORD SENDER PAUSED until ${until.toISOString()}: ${result.reason}`);
          await this.deps.rateLimits.block(DISCORD_GLOBAL_BUCKET, until);
          await this.retryLater(delivery, attempt, until, `${DeliveryReasons.senderPaused}: ${result.reason}`);
          return;
        }
        await this.settle(delivery, { status: DeliveryStatuses.failed, error: result.reason });
        return;
      }
      case DiscordResultKinds.transient: {
        const responseCode = result.status ?? null;
        if (attempt.attempt >= DeliveryPolicy.maxAttempts) {
          await this.settle(delivery, { status: DeliveryStatuses.failed, error: result.reason, responseCode });
        } else {
          await this.deps.deliveries.updateQueued(delivery.id, {
            error: result.reason,
            responseCode,
            nextAttemptAt: null,
          });
        }
        throw new TransientDeliveryError(result.reason);
      }
      default: {
        const unexpected: never = result;
        throw new Error(`unexpected Discord result ${JSON.stringify(unexpected)}`);
      }
    }
  }

  /**
   * Keep the delivery queued and ask the job to run again at `at`. On the job's last
   * attempt the delivery is failed with the reason instead, so it never stays
   * `queued` behind a dead job.
   */
  private async retryLater(
    delivery: DeliveryRow,
    attempt: DeliveryAttempt,
    at: Date,
    reason: string,
    responseCode: number | null = null,
  ): Promise<void> {
    if (attempt.attempt >= DeliveryPolicy.maxAttempts) {
      await this.settle(delivery, { status: DeliveryStatuses.failed, error: reason, responseCode });
      return;
    }
    await this.deps.deliveries.updateQueued(delivery.id, { error: reason, responseCode, nextAttemptAt: at });
    throw new RetryAt(at, reason);
  }

  private async settle(
    delivery: DeliveryRow,
    values: Parameters<DeliveryRepo['updateQueued']>[1] & { status: string },
  ): Promise<void> {
    await this.deps.deliveries.updateQueued(delivery.id, { nextAttemptAt: null, ...values });
  }

  async deliver(deliveryId: string, attempt: DeliveryAttempt): Promise<void> {
    const delivery = await this.deps.deliveries.findById(deliveryId);
    if (delivery?.status !== DeliveryStatuses.queued) {
      // Gone with its event (pruned) or already settled by an earlier run.
      return;
    }
    const channel =
      delivery.channelId === null
        ? undefined
        : await this.deps.channels.findById(delivery.workspaceId, delivery.channelId);
    if (channel === undefined) {
      await this.settle(delivery, { status: DeliveryStatuses.suppressed, error: DeliveryReasons.channelDeleted });
      return;
    }
    if (channel.status === ChannelStatuses.disabled) {
      await this.settle(delivery, {
        status: DeliveryStatuses.failed,
        error: DeliveryReasons.channelDisabled(channel.disabledReason),
      });
      return;
    }
    const { discord } = this.deps;
    if (discord === undefined) {
      console.error(`[notification] ${DeliveryReasons.notConfigured}: delivery ${delivery.id} waits`);
      await this.retryLater(
        delivery,
        attempt,
        new Date(attempt.now.getTime() + DeliveryPolicy.notConfiguredRetryMs),
        DeliveryReasons.notConfigured,
      );
      return;
    }
    if (!(await this.hasCapacity(delivery, channel, attempt))) {
      return;
    }
    await this.deps.deliveries.recordAttempt(delivery.id);
    const result = await discord.sendMessage(channel.externalId, delivery.message);
    if (result.kind === DiscordResultKinds.sent) {
      await this.sent(delivery, result, attempt.now);
      return;
    }
    await this.failed(delivery, channel, result, attempt);
  }
}
