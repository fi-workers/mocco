// Messenger (#95): conversations between a product's signed-in users and its team. The
// first surface is in-app "contact us" (a conversation started with a category and a
// first message); the data model is the messenger's, so chat comes later without a
// migration. Wire schemas for /v1/messenger (end users) and the operator inbox (tRPC).
import { z } from 'zod';

export const ConversationStatuses = { open: 'open', closed: 'closed' } as const;
export type ConversationStatus = (typeof ConversationStatuses)[keyof typeof ConversationStatuses];
export const conversationStatusSchema = z.enum(
  Object.values(ConversationStatuses) as [ConversationStatus, ...ConversationStatus[]],
);

/** Who wrote a message. */
export const AuthorKinds = { contact: 'contact', operator: 'operator', system: 'system' } as const;
export type AuthorKind = (typeof AuthorKinds)[keyof typeof AuthorKinds];

/** Internal notes are for the team only and never served to the contact. */
export const MessageVisibilities = { public: 'public', internal: 'internal' } as const;
export type MessageVisibility = (typeof MessageVisibilities)[keyof typeof MessageVisibilities];

export const MessengerLimits = {
  bodyMax: 8000,
  previewMax: 140,
  categories: 12,
  categoryKeyMax: 40,
  categoryLabelMax: 60,
  traitsMax: 20,
  externalUserIdMax: 255,
  pageSize: 50,
  attachmentsPerMessage: 3,
  attachmentMaxBytes: 10 * 1024 * 1024,
} as const;

/** What a user may attach: screenshots and photos. */
export const ATTACHMENT_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];

/** `POST /v1/messenger/attachments`: reserve an upload for a screenshot. */
export const attachmentCreateInputSchema = z.object({
  contentType: z.enum(ATTACHMENT_CONTENT_TYPES),
  sizeBytes: z.int().min(1).max(MessengerLimits.attachmentMaxBytes),
  filename: z.string().max(120).optional(),
});
export type AttachmentCreateInput = z.infer<typeof attachmentCreateInputSchema>;

const attachmentIdsSchema = z.array(z.uuid()).max(MessengerLimits.attachmentsPerMessage).optional();

/** An attachment as served: a short-lived download link. */
export const attachmentSchema = z.object({
  id: z.uuid(),
  contentType: z.string(),
  sizeBytes: z.int(),
  url: z.string(),
});
export type AttachmentDto = z.infer<typeof attachmentSchema>;

/** The categories a new project starts with; the team edits them in settings. */
export const DEFAULT_MESSENGER_CATEGORIES = [
  { key: 'bug', label: 'Bug report' },
  { key: 'billing', label: 'Billing and subscription' },
  { key: 'how-to', label: 'How to use' },
  { key: 'idea', label: 'Feature idea' },
  { key: 'other', label: 'Other' },
] as const;

export const messengerCategorySchema = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/u)
    .max(MessengerLimits.categoryKeyMax),
  label: z.string().trim().min(1).max(MessengerLimits.categoryLabelMax),
});
export type MessengerCategory = z.infer<typeof messengerCategorySchema>;

export const messengerCategoriesSchema = z
  .array(messengerCategorySchema)
  .min(1)
  .max(MessengerLimits.categories)
  .refine(categories => new Set(categories.map(category => category.key)).size === categories.length, {
    message: 'Category keys must be unique',
  });

/** What the SDK attaches about the device and app. All optional, all short. */
export const messengerContextSchema = z.object({
  appVersion: z.string().max(40).optional(),
  build: z.string().max(40).optional(),
  platform: z.enum(['ios', 'android', 'web']).optional(),
  os: z.string().max(60).optional(),
  device: z.string().max(80).optional(),
  locale: z.string().max(35).optional(),
  timezone: z.string().max(60).optional(),
  screen: z.string().max(200).optional(),
  sdkVersion: z.string().max(40).optional(),
});
export type MessengerContext = z.infer<typeof messengerContextSchema>;

/** Traits the app passes about its user, shown to the team. */
export const contactTraitsSchema = z
  .record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean()]))
  .refine(traits => Object.keys(traits).length <= MessengerLimits.traitsMax, {
    message: `At most ${MessengerLimits.traitsMax} traits`,
  });

/** A guest's device token, returned when a guest first writes; send it back to be found again. */
const guestTokenSchema = z.string().regex(/^mmg_[A-Za-z0-9_-]{20,}$/u);

/** `POST /v1/messenger/sessions` for a signed-in user, signed by the app's server. With
 * the device's `guestToken`, what they wrote as a guest moves to their account. */
export const identifiedSessionInputSchema = z.object({
  userId: z.string().min(1).max(MessengerLimits.externalUserIdMax),
  /** Hex HMAC-SHA256 of `userId` with the project's messenger identity secret. */
  userHash: z.string().regex(/^[0-9a-f]{64}$/u),
  name: z.string().trim().max(120).optional(),
  email: z.email().max(320).optional(),
  traits: contactTraitsSchema.optional(),
  guestToken: guestTokenSchema.optional(),
  context: messengerContextSchema.optional(),
});

/** `POST /v1/messenger/sessions` for someone not signed in (when the project allows
 * guests): an email to be reached at is required. */
export const guestSessionInputSchema = z.object({
  guest: z.literal(true),
  email: z.email().max(320),
  name: z.string().trim().max(120).optional(),
  guestToken: guestTokenSchema.optional(),
  context: messengerContextSchema.optional(),
});

export const messengerSessionInputSchema = z.union([identifiedSessionInputSchema, guestSessionInputSchema]);
export type IdentifiedSessionInput = z.infer<typeof identifiedSessionInputSchema>;
export type GuestSessionInput = z.infer<typeof guestSessionInputSchema>;
export type MessengerSessionInput = z.infer<typeof messengerSessionInputSchema>;

const bodySchema = z.string().trim().min(1).max(MessengerLimits.bodyMax);
/** Makes a retried send idempotent: the same id returns the message already stored. */
const clientMessageIdSchema = z.string().min(8).max(64);

export const conversationCreateInputSchema = z.object({
  category: z.string().max(MessengerLimits.categoryKeyMax).optional(),
  body: bodySchema,
  clientMessageId: clientMessageIdSchema,
  attachmentIds: attachmentIdsSchema,
  context: messengerContextSchema.optional(),
});
export type ConversationCreateInput = z.infer<typeof conversationCreateInputSchema>;

export const messageCreateInputSchema = z.object({
  body: bodySchema,
  clientMessageId: clientMessageIdSchema,
  attachmentIds: attachmentIdsSchema,
  context: messengerContextSchema.optional(),
});
export type MessageCreateInput = z.infer<typeof messageCreateInputSchema>;

export const markReadInputSchema = z.object({ seq: z.int().min(0) });

/** A conversation as its contact sees it. */
export const contactConversationSchema = z.object({
  id: z.uuid(),
  status: conversationStatusSchema,
  category: z.string().nullable(),
  preview: z.string(),
  lastMessageSeq: z.int(),
  lastMessageAt: z.iso.datetime(),
  /** The team replied after the contact last read. */
  hasUnread: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ContactConversationDto = z.infer<typeof contactConversationSchema>;

/** A public message as its contact sees it (internal notes never appear). */
export const contactMessageSchema = z.object({
  id: z.uuid(),
  seq: z.int(),
  author: z.enum([AuthorKinds.contact, AuthorKinds.operator, AuthorKinds.system]),
  /** The team member's display name, for operator messages. */
  authorName: z.string().nullable(),
  body: z.string(),
  attachments: z.array(attachmentSchema),
  createdAt: z.iso.datetime(),
});
export type ContactMessageDto = z.infer<typeof contactMessageSchema>;

export const messengerSessionSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.iso.datetime(),
  contactId: z.uuid(),
  categories: z.array(messengerCategorySchema),
  /** For a guest: the device token to keep and send back next time. */
  guestToken: z.string().optional(),
});
export type MessengerSessionDto = z.infer<typeof messengerSessionSchema>;

/** Where a contact's device takes push notifications (Expo's push service for now). */
export const PushProviders = { expo: 'expo' } as const;
export type PushProvider = (typeof PushProviders)[keyof typeof PushProviders];

/** `POST /v1/messenger/push-tokens`: the device's Expo push token. */
export const pushTokenInputSchema = z.object({
  provider: z.literal(PushProviders.expo),
  token: z
    .string()
    .max(200)
    .regex(/^Expo(nent)?PushToken\[[^\]]+\]$/u, 'An Expo push token looks like ExponentPushToken[…]'),
  platform: z.enum(['ios', 'android']),
});
export type PushTokenInput = z.infer<typeof pushTokenInputSchema>;

export const pushTokenDeleteInputSchema = pushTokenInputSchema.pick({ token: true });
