// What a webhook subscriber is sent (#156): one JSON event per delivery, signed by the webhook
// sender (Standard Webhooks headers). The body carries the same content as the mail, plus the
// signed links: `confirm` on the confirmation event, which the receiver opens to start the
// subscription, and `unsubscribe` on every event.
import { SubscriberMailKinds } from '@mocco/common/status';

import type { SubscriberMailContent } from '@backend/domain/status/subscriber-mail';
import type { SubscriberMailKind } from '@mocco/common/status';

/** The event `type` per delivery kind. */
export const SubscriberWebhookEventTypes: Record<SubscriberMailKind, string> = {
  [SubscriberMailKinds.confirmation]: 'subscription.confirmation',
  [SubscriberMailKinds.incidentUpdate]: 'incident.updated',
  [SubscriberMailKinds.maintenance]: 'maintenance.updated',
};

/** The additional authenticated data a page's webhook secrets are sealed with. */
export const webhookSecretAad = (pageId: string) => `status-subscriber-webhook:${pageId}`;

/** The JSON body of one webhook delivery. */
export function renderSubscriberWebhook(
  content: SubscriberMailContent,
  opts: { page: { slug: string; title: string }; confirmUrl: string; unsubscribeUrl: string; sentAt: Date },
): string {
  const { kind, ...data } = content;
  return JSON.stringify({
    type: SubscriberWebhookEventTypes[kind],
    sentAt: opts.sentAt.toISOString(),
    page: { slug: opts.page.slug, title: opts.page.title },
    data,
    links: {
      ...(kind === SubscriberMailKinds.confirmation && { confirm: opts.confirmUrl }),
      unsubscribe: opts.unsubscribeUrl,
    },
  });
}
