import { z } from 'zod';

import { defineJob } from '@backend/domain/jobs/handlers';
import { DeliveryPolicy, NotificationJobKinds } from '@backend/domain/notification/constants';
import { isRuleMatch, matchablePayloadSchema, type MatchableEvent } from '@backend/domain/notification/rules';
import { renderEventMessage } from '@backend/domain/notification/templates';

import type { DeliveredEvent } from '@backend/domain/events/EventBus';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { ChannelRepo, ChannelRow } from '@backend/domain/notification/repos/channel.repo';
import type { DeliveryRepo } from '@backend/domain/notification/repos/delivery.repo';
import type { RuleRepo, RuleRow } from '@backend/domain/notification/repos/rule.repo';

/** Send one delivery. Deduped by the delivery id while live. */
export const deliverNotification = defineJob(NotificationJobKinds.deliver, z.object({ deliveryId: z.uuid() }));

export interface NotificationServiceDeps {
  channels: ChannelRepo;
  rules: RuleRepo;
  deliveries: DeliveryRepo;
  queue: JobQueue;
  /** The app's origin, for the links in governance messages. */
  appOrigin: string;
}

/** What the rule matcher reads from a catalog event. */
export function toMatchableEvent(event: DeliveredEvent): MatchableEvent {
  const { facts, sourceId } = matchablePayloadSchema.parse(event.payload);
  return { type: event.type, facts, ...(sourceId !== undefined && { sourceId }) };
}

/**
 * The notification fan-out (platform foundations §12): a domain event subscriber that
 * turns one event into one queued delivery per active channel of the event's
 * workspace with at least one matching rule, each with its `notification.deliver` job.
 */
export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  /** Insert the delivery and enqueue its job in one transaction; the job id when created. */
  private async createDelivery(
    event: DeliveredEvent,
    target: { channel: ChannelRow; rule: RuleRow },
    message: ReturnType<typeof renderEventMessage>,
  ): Promise<string | undefined> {
    const result = await this.deps.deliveries.createQueued(
      {
        workspaceId: event.workspaceId,
        channelId: target.channel.id,
        eventId: event.id,
        ruleId: target.rule.id,
        message,
      },
      async (delivery, executor) =>
        await this.deps.queue.enqueue(
          deliverNotification,
          { deliveryId: delivery.id },
          {
            executor,
            workspaceId: event.workspaceId,
            dedupeKey: delivery.id,
            maxAttempts: DeliveryPolicy.maxAttempts,
          },
        ),
    );
    return result?.created.created === true ? result.created.job.id : undefined;
  }

  /**
   * Fan out `event`. Idempotent: an event handed over again (a redelivered event job)
   * finds its deliveries already there (UNIQUE (event_id, channel_id)) and creates
   * nothing. Each delivery and its job commit together, and are kicked after the commit.
   */
  async handle(event: DeliveredEvent): Promise<void> {
    const channels = await this.deps.channels.findActiveByWorkspace(event.workspaceId);
    if (channels.length === 0) {
      return;
    }
    const rules = await this.deps.rules.findByWorkspace(event.workspaceId);
    const matchable = toMatchableEvent(event);
    const targets = channels.flatMap(channel => {
      const rule = rules.find(candidate => candidate.channelId === channel.id && isRuleMatch(candidate, matchable));
      return rule === undefined ? [] : [{ channel, rule }];
    });
    if (targets.length === 0) {
      return;
    }
    const message = renderEventMessage(event, { appOrigin: this.deps.appOrigin });
    // One target at a time: production's pool is a single connection. Each delivery's
    // transaction has committed when createDelivery returns, so its job can be kicked.
    await targets.reduce(async (previous, target) => {
      await previous;
      const jobId = await this.createDelivery(event, target, message);
      if (jobId !== undefined) {
        this.deps.queue.kick(jobId);
      }
    }, Promise.resolve());
  }
}
