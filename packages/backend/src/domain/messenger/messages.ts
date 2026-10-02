// The notification messages for messenger events (rendered when the event is recorded).
// Pure. They name the contact and quote the start of the message; the full text stays
// in Mocco.
import { MessengerEventTypes } from '@mocco/common/events';
import { Severities } from '@mocco/common/notification';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { ContactRow } from '@backend/domain/messenger/repos/contact.repo';
import type { ConversationRow } from '@backend/domain/messenger/repos/conversation.repo';

type MessengerEventType = (typeof MessengerEventTypes)[keyof typeof MessengerEventTypes];

const QUOTE_MAX = 300;

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** Who the contact is, for a title: name, then email, then the app's user id. */
export const contactLabel = (contact: Pick<ContactRow, 'name' | 'email' | 'externalUserId'>): string =>
  contact.name ?? contact.email ?? contact.externalUserId ?? 'A guest';

export function contactMessageEvent(
  type: MessengerEventType,
  subject: { contact: ContactRow; conversation: ConversationRow; body: string },
  appOrigin: string | undefined,
): PublishInput {
  const { contact, conversation, body } = subject;
  const isNew = type === MessengerEventTypes.messengerConversationCreated;
  const who = contactLabel(contact);
  const context = conversation.contextAtOpen;
  const version = [context.appVersion, context.build === undefined ? undefined : `(${context.build})`]
    .filter(Boolean)
    .join(' ');
  return {
    type,
    workspaceId: contact.workspaceId,
    projectId: contact.projectId,
    subject: { type: 'messenger_conversation', id: conversation.id },
    payload: {
      facts: {
        ...(conversation.category !== null && { category: conversation.category }),
        ...(context.platform !== undefined && { platform: context.platform }),
      },
      message: {
        title: clip(isNew ? `New message from ${who}` : `${who} replied`, 200),
        ...(appOrigin !== undefined && {
          url: `${appOrigin}/workspaces/${contact.workspaceId}/p/${contact.projectId}/inbox/${conversation.id}`,
        }),
        description: clip(body, QUOTE_MAX),
        severity: Severities.info,
        fields: [
          ...(conversation.category === null ? [] : [{ name: 'Category', value: conversation.category, inline: true }]),
          ...(version === '' ? [] : [{ name: 'App version', value: clip(version, 100), inline: true }]),
          ...(context.platform === undefined ? [] : [{ name: 'Platform', value: context.platform, inline: true }]),
        ],
        footer: 'Mocco messenger',
      },
    },
  };
}
