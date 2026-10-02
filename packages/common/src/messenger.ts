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
} as const;

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

/** `POST /v1/messenger/sessions`: the app's user, signed by the app's server. */
export const messengerSessionInputSchema = z.object({
  userId: z.string().min(1).max(MessengerLimits.externalUserIdMax),
  /** Hex HMAC-SHA256 of `userId` with the project's messenger identity secret. */
  userHash: z.string().regex(/^[0-9a-f]{64}$/u),
  name: z.string().trim().max(120).optional(),
  email: z.email().max(320).optional(),
  traits: contactTraitsSchema.optional(),
  context: messengerContextSchema.optional(),
});
export type MessengerSessionInput = z.infer<typeof messengerSessionInputSchema>;

const bodySchema = z.string().trim().min(1).max(MessengerLimits.bodyMax);
/** Makes a retried send idempotent: the same id returns the message already stored. */
const clientMessageIdSchema = z.string().min(8).max(64);

export const conversationCreateInputSchema = z.object({
  category: z.string().max(MessengerLimits.categoryKeyMax).optional(),
  body: bodySchema,
  clientMessageId: clientMessageIdSchema,
  context: messengerContextSchema.optional(),
});
export type ConversationCreateInput = z.infer<typeof conversationCreateInputSchema>;

export const messageCreateInputSchema = z.object({
  body: bodySchema,
  clientMessageId: clientMessageIdSchema,
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
  createdAt: z.iso.datetime(),
});
export type ContactMessageDto = z.infer<typeof contactMessageSchema>;

export const messengerSessionSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.iso.datetime(),
  contactId: z.uuid(),
  categories: z.array(messengerCategorySchema),
});
export type MessengerSessionDto = z.infer<typeof messengerSessionSchema>;
