// Status page subscribers (#156): a visitor signs up with an email address, confirms it from the
// mail (double opt-in), and is then sent each published incident update and maintenance change
// of the page, filtered to the components they chose. Every mail is a delivery row unique per
// subscriber and notice, so a repeated fan-out sends nothing new, and a delivery is sent at most
// once. The confirm and unsubscribe links are signed tokens (`subscriber-token.ts`).
import { DeliveryStatuses } from '@mocco/common/notification';
import { IncidentVisibilities, SubscriberLocales, SubscriberMailKinds } from '@mocco/common/status';

import { RetryAt } from '@backend/domain/jobs/retry-at';
import { EmailResultKinds } from '@backend/domain/notification/senders/email';
import {
  StatusEntityNotFoundError,
  SubscriberComponentError,
  SubscriberDeliveryRetryError,
  SubscriberTokenError,
} from '@backend/domain/status/errors';
import { deliverToSubscriber } from '@backend/domain/status/jobs';
import { ComponentRepo } from '@backend/domain/status/repos/component.repo';
import { IncidentComponentRepo } from '@backend/domain/status/repos/incident-component.repo';
import { IncidentUpdateRepo } from '@backend/domain/status/repos/incident-update.repo';
import { IncidentRepo } from '@backend/domain/status/repos/incident.repo';
import { MaintenanceComponentRepo } from '@backend/domain/status/repos/maintenance-component.repo';
import { MaintenanceRepo } from '@backend/domain/status/repos/maintenance.repo';
import { StatusPageRepo } from '@backend/domain/status/repos/page.repo';
import { SubscriberDeliveryRepo } from '@backend/domain/status/repos/subscriber-delivery.repo';
import { SubscriberRepo } from '@backend/domain/status/repos/subscriber.repo';
import { renderSubscriberMail, subscriberMailContentSchema } from '@backend/domain/status/subscriber-mail';
import { CONFIRM_TOKEN_TTL_MS, SubscriberTokenPurposes } from '@backend/domain/status/subscriber-token';
import { noticeKeyOf } from '@backend/domain/status/SubscriberNotices';
import { inBatches } from '@backend/infra/db/rows';

import type { JobQueue } from '@backend/domain/jobs/ports';
import type { EmailResult, EmailSender } from '@backend/domain/notification/senders/email';
import type { RateLimitRule } from '@backend/domain/ratelimit/ports';
import type { SubscriberNotice } from '@backend/domain/status/jobs';
import type { StatusPageRow } from '@backend/domain/status/repos/page.repo';
import type { SubscriberDeliveryRow } from '@backend/domain/status/repos/subscriber-delivery.repo';
import type { SubscriberRow } from '@backend/domain/status/repos/subscriber.repo';
import type { SubscriberMailContent } from '@backend/domain/status/subscriber-mail';
import type { SubscriberTokenPurpose, SubscriberTokens } from '@backend/domain/status/subscriber-token';
import type { Db } from '@backend/infra/db/types';
import type { StatusSubscribeInput, SubscriberLocale } from '@mocco/common/status';

/** Limits of the public sign-up route: per client address, and per page and address. */
export const SubscriberRateLimits = {
  perClient: { limit: 10, windowSeconds: 600 },
  perEmail: { limit: 3, windowSeconds: 3600 },
  /** The confirm and unsubscribe links, per client address. */
  links: { limit: 30, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export const SubscriberPolicy = {
  /** A sign-up queues at most one confirmation mail in this long. */
  confirmationIntervalMs: 10 * 60 * 1000,
  /** A delivery claimed this long ago by a run that never settled it is given up, not resent. */
  sendingStaleMs: 2 * 60 * 1000,
  maxAttempts: 8,
  /** Deliveries per transaction in a fan-out. */
  fanOutBatch: 200,
  /** Settled deliveries are kept this long (the dedupe window). */
  deliveryRetentionMs: 90 * 24 * 60 * 60 * 1000,
} as const;

export interface SubscriberServiceDeps {
  db: Db;
  queue: JobQueue;
  tokens: SubscriberTokens;
  /** Undefined when this deployment sends no email: deliveries then fail. */
  email: EmailSender | undefined;
  /** The app's origin, for the links in mail. */
  appOrigin: string;
  now?: () => Date;
}

/** Which run of the delivery job this is. */
export interface SubscriberDeliveryAttempt {
  isFinalAttempt: boolean;
  now: Date;
}

/** What a sign-up did. The public route answers the same in every case, so it can't be used to
 * find out who follows a page. */
export const SubscribeOutcomes = {
  /** A confirmation mail was queued. */
  confirmationQueued: 'confirmation_queued',
  /** One was queued recently; no new one. */
  throttled: 'throttled',
  /** The address already follows the page; nothing changed. */
  alreadySubscribed: 'already_subscribed',
} as const;
export type SubscribeOutcome = (typeof SubscribeOutcomes)[keyof typeof SubscribeOutcomes];

/** A notice resolved: the page, the components it is about, and what the mail says. */
interface NoticeTarget {
  page: StatusPageRow;
  componentIds: string[];
  content: SubscriberMailContent;
}

/** Whether a subscriber wants a notice about `componentIds`. A subscriber without a filter gets
 * everything, and so does everyone for a notice about no component in particular. */
function isWanted(subscriber: SubscriberRow, componentIds: readonly string[]): boolean {
  if (subscriber.componentIds === null || componentIds.length === 0) {
    return true;
  }
  return subscriber.componentIds.some(id => componentIds.includes(id));
}

/** Why a delivery must not be sent to the subscriber as they are now, if it mustn't. */
function suppressionOf(delivery: SubscriberDeliveryRow, subscriber: SubscriberRow): string | undefined {
  if (subscriber.unsubscribedAt !== null) {
    return 'unsubscribed';
  }
  if (delivery.kind === SubscriberMailKinds.confirmation) {
    return subscriber.confirmedAt === null ? undefined : 'already confirmed';
  }
  // Only the confirmation mail goes to an address that hasn't confirmed.
  return subscriber.confirmedAt === null ? 'not confirmed' : undefined;
}

export class SubscriberService {
  constructor(private readonly deps: SubscriberServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async pageBySlug(slug: string): Promise<StatusPageRow> {
    const page = await new StatusPageRepo(this.deps.db).findBySlug(slug);
    if (page === undefined) {
      throw new StatusEntityNotFoundError('page', slug);
    }
    return page;
  }

  /** The subscriber a link of `purpose` names, on the page at `slug`; SubscriberTokenError otherwise. */
  private async subscriberOfLink(slug: string, purpose: SubscriberTokenPurpose, token: string) {
    const id = this.deps.tokens.verify(purpose, token, this.now());
    const [page, subscriber] = await Promise.all([
      new StatusPageRepo(this.deps.db).findBySlug(slug),
      id === null ? undefined : new SubscriberRepo(this.deps.db).findById(id),
    ]);
    if (page === undefined || subscriber === undefined || subscriber.pageId !== page.id) {
      throw new SubscriberTokenError();
    }
    return { page, subscriber };
  }

  private linkOf(page: StatusPageRow, action: 'confirm' | 'unsubscribe', token: string): string {
    const path = `/api/ext/v1/status-pages/${page.slug}/subscribers/${action}`;
    return `${this.deps.appOrigin}${path}?token=${encodeURIComponent(token)}`;
  }

  private async enqueueDelivery(tx: Db, delivery: SubscriberDeliveryRow): Promise<string> {
    const { job } = await this.deps.queue.enqueue(
      deliverToSubscriber,
      { deliveryId: delivery.id },
      {
        executor: tx,
        dedupeKey: delivery.id,
        workspaceId: delivery.workspaceId,
        maxAttempts: SubscriberPolicy.maxAttempts,
      },
    );
    return job.id;
  }

  /** The page, components and mail content of a notice; undefined when there is nothing to send
   * (the update or window is gone, or the incident is a draft). */
  private async targetOf(notice: SubscriberNotice): Promise<NoticeTarget | undefined> {
    const { db } = this.deps;
    const scope = { workspaceId: notice.workspaceId, projectId: notice.projectId };
    if (notice.kind === SubscriberMailKinds.incidentUpdate) {
      const update = await new IncidentUpdateRepo(db).find(notice.workspaceId, notice.updateId);
      const incident = update === undefined ? undefined : await new IncidentRepo(db).find(scope, update.incidentId);
      if (update === undefined || incident === undefined || incident.visibility !== IncidentVisibilities.published) {
        return undefined;
      }
      const page = await new StatusPageRepo(db).find(scope, incident.pageId);
      if (page === undefined) {
        return undefined;
      }
      const affected = await new IncidentComponentRepo(db).listForIncident(notice.workspaceId, incident.id);
      const componentIds = affected.map(link => link.componentId);
      return {
        page,
        componentIds,
        content: {
          kind: SubscriberMailKinds.incidentUpdate,
          incidentTitle: incident.title,
          status: update.status,
          body: update.bodyMd,
          components: await this.namesOf(page, componentIds),
          postedAt: update.createdAt.toISOString(),
        },
      };
    }
    const window = await new MaintenanceRepo(db).find(scope, notice.maintenanceId);
    const page = window === undefined ? undefined : await new StatusPageRepo(db).find(scope, window.pageId);
    if (window === undefined || page === undefined) {
      return undefined;
    }
    const covered = await new MaintenanceComponentRepo(db).listFor(notice.workspaceId, [window.id]);
    const componentIds = covered.map(link => link.componentId);
    return {
      page,
      componentIds,
      content: {
        kind: SubscriberMailKinds.maintenance,
        title: window.title,
        status: notice.status,
        body: window.bodyMd,
        components: await this.namesOf(page, componentIds),
        scheduledStart: window.scheduledStart.toISOString(),
        scheduledEnd: window.scheduledEnd.toISOString(),
      },
    };
  }

  /** The names of `componentIds`, in the page's order. */
  private async namesOf(page: StatusPageRow, componentIds: readonly string[]): Promise<string[]> {
    const scope = { workspaceId: page.workspaceId, projectId: page.projectId };
    const components = await new ComponentRepo(this.deps.db).listForPage(scope, page.id);
    return components.filter(component => componentIds.includes(component.id)).map(component => component.name);
  }

  /** A delivery found `sending`: wait for the run holding a fresh claim, or give a stale one up. */
  private async settleClaimed(delivery: SubscriberDeliveryRow, now: Date): Promise<void> {
    const staleAt = (delivery.sendingAt ?? now).getTime() + SubscriberPolicy.sendingStaleMs;
    if (staleAt > now.getTime()) {
      throw new RetryAt(new Date(staleAt), 'another run is sending', { consumesAttempt: false });
    }
    // The run that claimed it died, perhaps after the relay took the mail: never send it twice.
    await new SubscriberDeliveryRepo(this.deps.db).updateFrom(delivery.id, DeliveryStatuses.sending, {
      status: DeliveryStatuses.failed,
      error: 'interrupted while sending; not sent again',
      sendingAt: null,
    });
  }

  /** Settle a claimed delivery from the relay's answer; throw so the job retries a transient one. */
  private async settleResult(
    delivery: SubscriberDeliveryRow,
    result: EmailResult,
    attempt: SubscriberDeliveryAttempt,
  ): Promise<void> {
    const deliveries = new SubscriberDeliveryRepo(this.deps.db);
    const from = DeliveryStatuses.sending;
    if (result.kind === EmailResultKinds.sent) {
      await deliveries.updateFrom(delivery.id, from, {
        status: DeliveryStatuses.sent,
        sentAt: attempt.now,
        sendingAt: null,
        error: null,
      });
      return;
    }
    if (result.kind === EmailResultKinds.permanent || attempt.isFinalAttempt) {
      await deliveries.updateFrom(delivery.id, from, {
        status: DeliveryStatuses.failed,
        error: result.reason,
        sendingAt: null,
      });
      return;
    }
    // Not taken for now: back to queued, and the job backs off and tries again.
    await deliveries.updateFrom(delivery.id, from, {
      status: DeliveryStatuses.queued,
      error: result.reason,
      sendingAt: null,
    });
    throw new SubscriberDeliveryRetryError(result.reason);
  }

  /** The mail of a queued delivery, or why it is not sent (`suppressed` or `failed`). */
  // eslint-disable-next-line sonarjs/function-return-type -- a union: the mail, or the refusal
  private composeMail(delivery: SubscriberDeliveryRow, subscriber: SubscriberRow, page: StatusPageRow, now: Date) {
    const suppressed = suppressionOf(delivery, subscriber);
    if (suppressed !== undefined) {
      return { refused: { status: DeliveryStatuses.suppressed, error: suppressed } };
    }
    const content = subscriberMailContentSchema.safeParse(delivery.content);
    if (!content.success || subscriber.email === null) {
      const error = content.success ? 'no email address' : 'unreadable mail content';
      return { refused: { status: DeliveryStatuses.failed, error } };
    }
    const { tokens } = this.deps;
    const confirm = tokens.issue(SubscriberTokenPurposes.confirm, subscriber.id, now);
    const unsubscribe = tokens.issue(SubscriberTokenPurposes.unsubscribe, subscriber.id, now);
    const mail = renderSubscriberMail(content.data, {
      locale: subscriber.locale,
      pageTitle: page.title,
      confirmUrl: this.linkOf(page, 'confirm', confirm),
      unsubscribeUrl: this.linkOf(page, 'unsubscribe', unsubscribe),
    });
    return { mail: { ...mail, to: subscriber.email } };
  }

  /** Whether this deployment sends mail; without it sign-ups are refused (links still work). */
  canSendMail(): boolean {
    return this.deps.email !== undefined;
  }

  /**
   * Sign an address up for the page at `slug`, pending confirmation, and queue the confirmation
   * mail (at most one per `confirmationIntervalMs`). Throws StatusEntityNotFoundError for an
   * unknown page and SubscriberComponentError for a component that isn't on it.
   */
  async subscribe(slug: string, input: Omit<StatusSubscribeInput, 'website'>): Promise<SubscribeOutcome> {
    const page = await this.pageBySlug(slug);
    const scope = { workspaceId: page.workspaceId, projectId: page.projectId };
    const componentIds = input.componentIds === undefined ? null : [...new Set(input.componentIds)];
    if (componentIds !== null) {
      const found = new Set(await new ComponentRepo(this.deps.db).idsOnPage(scope, page.id, componentIds));
      const missing = componentIds.find(id => !found.has(id));
      if (missing !== undefined) {
        throw new SubscriberComponentError(missing);
      }
    }
    const subscriber = await new SubscriberRepo(this.deps.db).upsertPendingEmail({
      ...scope,
      pageId: page.id,
      email: input.email,
      componentIds,
      locale: input.locale ?? SubscriberLocales.en,
    });
    if (subscriber === undefined) {
      return SubscribeOutcomes.alreadySubscribed;
    }
    const now = this.now();
    const jobId = await this.deps.db.transaction(async tx => {
      const since = new Date(now.getTime() - SubscriberPolicy.confirmationIntervalMs);
      if (!(await new SubscriberRepo(tx).claimConfirmation(subscriber.id, now, since))) {
        return undefined;
      }
      const [delivery] = await new SubscriberDeliveryRepo(tx).insertNew([
        {
          workspaceId: subscriber.workspaceId,
          subscriberId: subscriber.id,
          kind: SubscriberMailKinds.confirmation,
          dedupeKey: `${SubscriberMailKinds.confirmation}:${now.toISOString()}`,
          content: { kind: SubscriberMailKinds.confirmation },
        },
      ]);
      return delivery === undefined ? undefined : await this.enqueueDelivery(tx, delivery);
    });
    if (jobId === undefined) {
      return SubscribeOutcomes.throttled;
    }
    this.deps.queue.kick(jobId);
    return SubscribeOutcomes.confirmationQueued;
  }

  /** Confirm the sign-up a confirmation link names. */
  async confirm(slug: string, token: string): Promise<{ pageTitle: string; locale: SubscriberLocale }> {
    const { page, subscriber } = await this.subscriberOfLink(slug, SubscriberTokenPurposes.confirm, token);
    const confirmed = await new SubscriberRepo(this.deps.db).confirm(subscriber.id, this.now());
    if (confirmed === undefined) {
      // Unsubscribed since the mail was sent.
      throw new SubscriberTokenError();
    }
    return { pageTitle: page.title, locale: subscriber.locale };
  }

  /** What an unsubscribe link is for, without acting on it (the page that asks first). */
  async describeUnsubscribe(slug: string, token: string): Promise<{ pageTitle: string; locale: SubscriberLocale }> {
    const { page, subscriber } = await this.subscriberOfLink(slug, SubscriberTokenPurposes.unsubscribe, token);
    return { pageTitle: page.title, locale: subscriber.locale };
  }

  /** Unsubscribe the subscriber an unsubscribe link names. Doing it twice is fine. */
  async unsubscribe(slug: string, token: string): Promise<{ pageTitle: string; locale: SubscriberLocale }> {
    const { page, subscriber } = await this.subscriberOfLink(slug, SubscriberTokenPurposes.unsubscribe, token);
    await new SubscriberRepo(this.deps.db).unsubscribe(subscriber.id, this.now());
    return { pageTitle: page.title, locale: subscriber.locale };
  }

  /**
   * Queue the notice's mail to every confirmed subscriber of its page who wants it: one delivery
   * and one delivery job each, committed together. A pair that already has a delivery (the fan-out
   * ran before) gets nothing new. Runs as the `status.subscribers.fanout` job.
   */
  async fanOut(notice: SubscriberNotice): Promise<{ queued: number }> {
    const target = await this.targetOf(notice);
    if (target === undefined) {
      return { queued: 0 };
    }
    const active = await new SubscriberRepo(this.deps.db).listActiveEmail(target.page.id);
    const subscribers = active.filter(subscriber => isWanted(subscriber, target.componentIds));
    const dedupeKey = noticeKeyOf(notice);
    const jobIds: string[] = [];
    await inBatches(subscribers, SubscriberPolicy.fanOutBatch, async batch => {
      const ids = await this.deps.db.transaction(async tx => {
        const inserted = await new SubscriberDeliveryRepo(tx).insertNew(
          batch.map(subscriber => ({
            workspaceId: subscriber.workspaceId,
            subscriberId: subscriber.id,
            kind: notice.kind,
            dedupeKey,
            content: target.content,
          })),
        );
        return await inserted.reduce<Promise<string[]>>(
          async (previous, delivery) => [...(await previous), await this.enqueueDelivery(tx, delivery)],
          Promise.resolve([]),
        );
      });
      jobIds.push(...ids);
    });
    // eslint-disable-next-line no-restricted-syntax -- each kick is a side effect, not a mapping
    for (const jobId of jobIds) {
      this.deps.queue.kick(jobId);
    }
    return { queued: jobIds.length };
  }

  /**
   * Send one delivery. A delivery is sent at most once: it is claimed (`sending`) before the mail
   * goes out, and a claim left by a run that died is given up (`failed`) rather than sent again,
   * since mail can't be taken back. Runs as the `status.subscribers.deliver` job.
   */
  async deliver(deliveryId: string, attempt: SubscriberDeliveryAttempt): Promise<void> {
    const deliveries = new SubscriberDeliveryRepo(this.deps.db);
    const delivery = await deliveries.findById(deliveryId);
    if (delivery?.status === DeliveryStatuses.sending) {
      await this.settleClaimed(delivery, attempt.now);
      return;
    }
    if (delivery?.status !== DeliveryStatuses.queued) {
      // Gone with its subscriber, or settled by an earlier run.
      return;
    }
    const subscriber = await new SubscriberRepo(this.deps.db).findById(delivery.subscriberId);
    const page =
      subscriber === undefined ? undefined : await new StatusPageRepo(this.deps.db).findById(subscriber.pageId);
    if (subscriber === undefined || page === undefined) {
      return;
    }
    const { email } = this.deps;
    const composed = this.composeMail(delivery, subscriber, page, attempt.now);
    if (composed.refused !== undefined || email === undefined) {
      const refused = composed.refused ?? {
        status: DeliveryStatuses.failed,
        error: 'email is not configured (EMAIL_DRIVER)',
      };
      await deliveries.updateFrom(delivery.id, DeliveryStatuses.queued, refused);
      return;
    }
    const claimed = await deliveries.claim(delivery.id, attempt.now);
    if (claimed === undefined) {
      // Another run claimed it between the read and the claim.
      return;
    }
    await this.settleResult(claimed, await email.send(composed.mail), attempt);
  }

  /** Delete sign-ups never confirmed whose link has expired, and settled deliveries past retention. */
  async prune(now: Date): Promise<{ subscribers: number; deliveries: number }> {
    const subscribers = await new SubscriberRepo(this.deps.db).pruneUnconfirmed(
      new Date(now.getTime() - CONFIRM_TOKEN_TTL_MS),
    );
    const deliveries = await new SubscriberDeliveryRepo(this.deps.db).pruneSettled(
      new Date(now.getTime() - SubscriberPolicy.deliveryRetentionMs),
    );
    return { subscribers, deliveries };
  }
}
