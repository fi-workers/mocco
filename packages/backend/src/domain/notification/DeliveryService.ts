import { ChannelStatuses, DeliveryStatuses } from '@mocco/common/notification';

import { RetryAt } from '@backend/domain/jobs/retry-at';
import { DeliveryPolicy, DeliveryReasons, NotificationJobKinds } from '@backend/domain/notification/constants';
import { TransientDeliveryError } from '@backend/domain/notification/errors';
import { DiscordResultKinds } from '@backend/domain/notification/senders/discord';
import {
  DISCORD_GLOBAL_BUCKET,
  discordChannelBucket,
  isDiscordSnowflake,
} from '@backend/domain/notification/senders/discord-constants';

import type { ChannelRepo, ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import type { DeliveryRepo, DeliveryRow, DeliveryUpdate } from '@backend/domain/notification/repos/delivery.repo';
import type { DiscordRateLimitRepo } from '@backend/domain/notification/repos/discord-rate-limit.repo';
import type { DiscordApi, DiscordFailure, DiscordSent } from '@backend/domain/notification/senders/discord';
import type { DeliveryStatus } from '@mocco/common/notification';

/** The part of the Discord client a delivery needs. */
export type DiscordMessenger = Pick<DiscordApi, 'sendMessage'>;

/** A delivery Discord accepted, as handed to `DeliveryServiceDeps.onSent`. */
export interface SentDelivery {
  delivery: DeliveryRow;
  channel: ChannelRow;
  /** Discord's id of the posted message. */
  messageId: string;
  now: Date;
}

/**
 * Called once a delivery is settled `sent` (the stage0 canary deletes its message and
 * pings the external heartbeat, docs/reference/ops-stage0.md). A port so the
 * notification domain never imports its listener; the job runtime binds it. It runs
 * after the delivery is settled: a throw is logged and never fails or retries it.
 */
export type DeliverySentListener = (sent: SentDelivery) => Promise<void>;

export interface DeliveryServiceDeps {
  deliveries: DeliveryRepo;
  channels: ChannelRepo;
  rateLimits: DiscordRateLimitRepo;
  /** Undefined when this deployment has no DISCORD_BOT_TOKEN. */
  discord: DiscordMessenger | undefined;
  /** [0, 1), for the jitter of workspace-limit wake-ups. */
  random: () => number;
  onSent?: DeliverySentListener;
}

/** Which run of the delivery job this is (from the job context). */
export interface DeliveryAttempt {
  /** The runner's verdict: a throw now ends the job dead (`JobContext.isFinalAttempt`). */
  isFinalAttempt: boolean;
  now: Date;
}

interface Wait {
  at: Date;
  reason: string;
  /** A capacity wait: free for the job, bounded by `DeliveryPolicy.maxQueuedMs` instead. */
  isFree: boolean;
  responseCode?: number;
}

/** The delivery id (a uuid) as 22 base64url characters: Discord's nonce is at most 25. */
export function deliveryNonce(deliveryId: string): string {
  // sonarjs/null-dereference is a false positive: `deliveryId` is a non-nullable string.
  // eslint-disable-next-line sonarjs/null-dereference
  const hex = deliveryId.replaceAll('-', '');
  // Buffer is the base64 codec available without V8's --js-base-64 flag (see secret-box.ts).
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  return Buffer.from(hex, 'hex').toString('base64url');
}

/** A `sending` claim taken before this was left by a run that died. */
function staleBefore(now: Date): Date {
  return new Date(now.getTime() - DeliveryPolicy.sendingStaleMs);
}

/** While another run holds a fresh claim, come back when it would turn stale. */
function waitForOtherRun(sendingAt: Date | null, now: Date): never {
  const at = new Date((sendingAt ?? now).getTime() + DeliveryPolicy.sendingStaleMs);
  throw new RetryAt(at, DeliveryReasons.alreadySending, { consumesAttempt: false });
}

/**
 * Runs one `notification.deliver` job: sends a delivery to its Discord channel and
 * settles it from the answer (relay design §6). Pacing is shared across runners through
 * `mocco_discord_rate_limits`. Capacity waits are free RetryAts (they never spend job
 * attempts) bounded by the delivery's age. A run claims the delivery (`sending`) before
 * calling Discord, and the post carries the delivery's nonce, so overlapping or retried
 * runs post once. A settled delivery (sent, failed, suppressed) is a no-op.
 */
export class DeliveryService {
  constructor(private readonly deps: DeliveryServiceDeps) {}

  /** Settle (or annotate) the delivery while it is still `from`; false when it no longer was. */
  private async settle(delivery: DeliveryRow, from: DeliveryStatus, values: DeliveryUpdate): Promise<boolean> {
    return await this.deps.deliveries.updateFrom(delivery.id, from, {
      nextAttemptAt: null,
      sendingAt: null,
      ...values,
    });
  }

  /**
   * Put the delivery back to `queued` and ask the job to run again at `wait.at`. A free
   * wait on a delivery older than `maxQueuedMs` fails it instead.
   */
  private async wait(delivery: DeliveryRow, from: DeliveryStatus, wait: Wait, now: Date): Promise<void> {
    const responseCode = wait.responseCode ?? null;
    if (wait.isFree && now.getTime() - delivery.createdAt.getTime() >= DeliveryPolicy.maxQueuedMs) {
      await this.settle(delivery, from, {
        status: DeliveryStatuses.failed,
        error: DeliveryReasons.expired(wait.reason),
        responseCode,
      });
      return;
    }
    await this.deps.deliveries.updateFrom(delivery.id, from, {
      status: DeliveryStatuses.queued,
      error: wait.reason,
      responseCode,
      nextAttemptAt: wait.at,
      sendingAt: null,
    });
    throw new RetryAt(wait.at, wait.reason, { consumesAttempt: !wait.isFree });
  }

  /** The capacity wait the delivery must take before sending, if any. */
  private async capacityWait(delivery: DeliveryRow, channel: ChannelRow, now: Date): Promise<Wait | undefined> {
    const buckets = [discordChannelBucket(channel.externalId), DISCORD_GLOBAL_BUCKET];
    const blockedUntil = await this.deps.rateLimits.blockedUntil(buckets, now);
    if (blockedUntil !== undefined) {
      return { at: blockedUntil, reason: DeliveryReasons.rateLimited, isFree: true };
    }
    const window = DeliveryPolicy.fairnessWindowMs;
    const { sent, oldest } = await this.deps.deliveries.sentSince(
      delivery.workspaceId,
      new Date(now.getTime() - window),
    );
    if (sent < DeliveryPolicy.workspacePerMinute) {
      return undefined;
    }
    // A slot frees when the oldest send of the window ages out of it. Jitter spreads the
    // waiting deliveries over the next window instead of waking them all at once.
    const freed = (oldest ?? now).getTime() + window + this.deps.random() * window;
    const at = new Date(Math.max(freed, now.getTime() + DeliveryPolicy.fairnessMinRetryMs));
    return { at, reason: DeliveryReasons.workspaceLimit, isFree: true };
  }

  private async sent(delivery: DeliveryRow, channel: ChannelRow, result: DiscordSent, now: Date): Promise<void> {
    const isSettled = await this.settle(delivery, DeliveryStatuses.sending, {
      status: DeliveryStatuses.sent,
      externalMessageId: result.messageId,
      sentAt: now,
      error: null,
    });
    // The bucket is exhausted: the next send to this channel waits for its reset.
    if (result.bucket?.blockedUntil !== undefined) {
      await this.deps.rateLimits.block(result.bucket.key, result.bucket.blockedUntil);
    }
    if (isSettled) {
      await this.notifySent({ delivery, channel, messageId: result.messageId, now });
    }
  }

  /** Hand a sent delivery to the listener; its failure never touches the delivery. */
  private async notifySent(sent: SentDelivery): Promise<void> {
    const { onSent } = this.deps;
    if (onSent === undefined) {
      return;
    }
    try {
      await onSent(sent);
    } catch (error) {
      console.error('[notification] the sent-delivery listener failed', {
        deliveryId: sent.delivery.id,
        error: error instanceof Error ? error.name : 'unknown error',
      });
    }
  }

  private async failed(
    delivery: DeliveryRow,
    channel: ChannelRow,
    result: DiscordFailure,
    attempt: DeliveryAttempt,
  ): Promise<void> {
    const from = DeliveryStatuses.sending;
    switch (result.kind) {
      case DiscordResultKinds.rate_limited: {
        await this.deps.rateLimits.block(result.bucketKey ?? discordChannelBucket(channel.externalId), result.retryAt);
        // A 429 is an invalid request to Discord, so it stays a consuming RetryAt (the
        // runner refunds a streak of five); a job that dies of them is reconciled.
        await this.wait(
          delivery,
          from,
          { at: result.retryAt, reason: DeliveryReasons.rateLimited, isFree: false, responseCode: 429 },
          attempt.now,
        );
        return;
      }
      case DiscordResultKinds.permanent: {
        if (result.disableChannel) {
          // The bot cannot reach this channel any more: stop sending to it (relay design §6).
          await this.deps.channels.disable(channel.workspaceId, channel.id, result.reason);
          await this.settle(delivery, from, { status: DeliveryStatuses.failed, error: result.reason });
          return;
        }
        if (result.disableSender) {
          // The bot token or our egress is rejected: an operator problem, not the
          // tenant's. Pause every send and keep the delivery queued.
          const until = new Date(attempt.now.getTime() + DeliveryPolicy.senderPauseMs);
          console.error(`[notification] DISCORD SENDER PAUSED until ${until.toISOString()}: ${result.reason}`);
          await this.deps.rateLimits.block(DISCORD_GLOBAL_BUCKET, until);
          await this.wait(
            delivery,
            from,
            { at: until, reason: `${DeliveryReasons.senderPaused}: ${result.reason}`, isFree: true },
            attempt.now,
          );
          return;
        }
        await this.settle(delivery, from, { status: DeliveryStatuses.failed, error: result.reason });
        return;
      }
      case DiscordResultKinds.transient: {
        const responseCode = result.status ?? null;
        await (attempt.isFinalAttempt
          ? this.settle(delivery, from, { status: DeliveryStatuses.failed, error: result.reason, responseCode })
          : this.deps.deliveries.updateFrom(delivery.id, from, {
              status: DeliveryStatuses.queued,
              error: result.reason,
              responseCode,
              nextAttemptAt: null,
              sendingAt: null,
            }));
        throw new TransientDeliveryError(result.reason);
      }
      default: {
        const unexpected: never = result;
        throw new Error(`unexpected Discord result ${JSON.stringify(unexpected)}`);
      }
    }
  }

  async deliver(deliveryId: string, attempt: DeliveryAttempt): Promise<void> {
    const { now } = attempt;
    const delivery = await this.deps.deliveries.findById(deliveryId);
    if (delivery === undefined) {
      // Gone with its event (pruned).
      return;
    }
    const { status } = delivery;
    if (status === DeliveryStatuses.sending && (delivery.sendingAt ?? now) >= staleBefore(now)) {
      waitForOtherRun(delivery.sendingAt, now);
    }
    if (status !== DeliveryStatuses.queued && status !== DeliveryStatuses.sending) {
      // Already settled by an earlier run.
      return;
    }
    const channel =
      delivery.channelId === null
        ? undefined
        : await this.deps.channels.findById(delivery.workspaceId, delivery.channelId);
    if (channel === undefined) {
      await this.settle(delivery, status, {
        status: DeliveryStatuses.suppressed,
        error: DeliveryReasons.channelDeleted,
      });
      return;
    }
    if (channel.status === ChannelStatuses.disabled) {
      await this.settle(delivery, status, {
        status: DeliveryStatuses.failed,
        error: DeliveryReasons.channelDisabled(channel.disabledReason),
      });
      return;
    }
    if (!isDiscordSnowflake(channel.externalId)) {
      await this.settle(delivery, status, { status: DeliveryStatuses.failed, error: DeliveryReasons.invalidChannelId });
      return;
    }
    const { discord } = this.deps;
    if (discord === undefined) {
      console.error(`[notification] ${DeliveryReasons.notConfigured}: delivery ${delivery.id} waits`);
      const at = new Date(now.getTime() + DeliveryPolicy.notConfiguredRetryMs);
      await this.wait(delivery, status, { at, reason: DeliveryReasons.notConfigured, isFree: true }, now);
      return;
    }
    const capacity = await this.capacityWait(delivery, channel, now);
    if (capacity !== undefined) {
      await this.wait(delivery, status, capacity, now);
      return;
    }
    const claimed = await this.deps.deliveries.claimForSending(delivery.id, now, staleBefore(now));
    if (claimed === undefined) {
      // Another run claimed it between our read and our claim.
      const current = await this.deps.deliveries.findById(delivery.id);
      if (current?.status === DeliveryStatuses.sending) {
        waitForOtherRun(current.sendingAt, now);
      }
      return;
    }
    const result = await discord.sendMessage(channel.externalId, claimed.message, {
      nonce: deliveryNonce(claimed.id),
    });
    if (result.kind === DiscordResultKinds.sent) {
      await this.sent(claimed, channel, result, now);
      return;
    }
    await this.failed(claimed, channel, result, attempt);
  }

  /**
   * Fail deliveries left unsettled by a job that died (every attempt spent, or the job
   * pruned): nothing else would ever settle them. Returns how many were failed.
   */
  async reconcile(): Promise<number> {
    const orphaned = await this.deps.deliveries.findOrphaned(
      NotificationJobKinds.deliver,
      DeliveryPolicy.reconcileBatch,
    );
    if (orphaned.length > 0) {
      console.warn(`[notification] failing ${orphaned.length} deliveries whose job ended before they settled`);
    }
    return await this.deps.deliveries.failUnsettled(
      orphaned.map(delivery => delivery.id),
      DeliveryReasons.orphaned,
    );
  }

  /** Delete Discord rate limit buckets whose block has ended. */
  async pruneRateLimits(now: Date): Promise<number> {
    return await this.deps.rateLimits.pruneExpired(now);
  }
}
