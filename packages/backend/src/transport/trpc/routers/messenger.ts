// Messenger router (#95) — the team's inbox and the project's messenger settings. Every
// procedure requires the messenger product to be enabled and the project to belong to
// the workspace (`productProcedure`), which maps the domain error families.
import {
  attachmentCreateInputSchema,
  attachmentIdsSchema,
  conversationStatusSchema,
  messengerCategoriesSchema,
  MessengerLimits,
} from '@mocco/common/messenger';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const conversationInput = projectInput.extend({ conversationId: z.uuid() });
const messengerProcedure = productProcedure(Products.messenger);

export const messengerRouter = router({
  /** The settings, or null while the messenger isn't set up for the project. */
  settings: messengerProcedure.input(projectInput).query(async ({ ctx, input }) => ({
    settings: (await ctx.messengerSettings.get(input.workspaceId, input.projectId)) ?? null,
  })),

  /** Set up the messenger; the identity secret is returned once. */
  enable: messengerProcedure
    .input(projectInput)
    .mutation(
      async ({ ctx, input }) =>
        await ctx.messengerSettings.enable(input.workspaceId, input.projectId, ctx.session.user.id),
    ),

  rotateSecret: messengerProcedure
    .input(projectInput)
    .mutation(
      async ({ ctx, input }) =>
        await ctx.messengerSettings.rotateSecret(input.workspaceId, input.projectId, ctx.session.user.id),
    ),

  setCategories: messengerProcedure
    .input(projectInput.extend({ categories: messengerCategoriesSchema }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.messengerSettings.setCategories(
          input.workspaceId,
          input.projectId,
          ctx.session.user.id,
          input.categories,
        ),
    ),

  /** Let people who aren't signed in write, leaving an email (off by default). */
  setAllowGuests: messengerProcedure
    .input(projectInput.extend({ allowGuests: z.boolean() }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.messengerSettings.setAllowGuests(
          input.workspaceId,
          input.projectId,
          ctx.session.user.id,
          input.allowGuests,
        ),
    ),

  inbox: messengerProcedure
    .input(projectInput.extend({ status: conversationStatusSchema.default('open'), before: z.date().optional() }))
    .query(async ({ ctx, input }) => ({
      conversations: await ctx.inbox.list(input.workspaceId, input.projectId, ctx.session.user.id, {
        status: input.status,
        ...(input.before !== undefined && { before: input.before }),
      }),
    })),

  conversation: messengerProcedure
    .input(conversationInput)
    .query(async ({ ctx, input }) => await ctx.inbox.get(input.workspaceId, input.projectId, input.conversationId)),

  /** Reserve an upload for an image or a PDF to send in the conversation; PUT the bytes,
   * then name the id in `write`'s `attachmentIds`. */
  createAttachment: messengerProcedure
    .input(conversationInput.extend(attachmentCreateInputSchema.shape))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.inbox.createAttachment(input.workspaceId, input.projectId, ctx.session.user.id, input),
    ),

  /** Reply to the contact, or add an internal note (`internal: true`) only the team sees,
   * with up to three attachments the caller reserved in this conversation. */
  write: messengerProcedure
    .input(
      conversationInput.extend({
        body: z.string().trim().min(1).max(MessengerLimits.bodyMax),
        internal: z.boolean().default(false),
        attachmentIds: attachmentIdsSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => ({
      message: await ctx.inbox.write(input.workspaceId, input.projectId, ctx.session.user.id, input),
    })),

  setStatus: messengerProcedure
    .input(conversationInput.extend({ status: conversationStatusSchema }))
    .mutation(async ({ ctx, input }) => ({
      conversation: await ctx.inbox.setStatus(input.workspaceId, input.projectId, input.conversationId, input.status),
    })),

  markRead: messengerProcedure.input(conversationInput).mutation(async ({ ctx, input }) => {
    await ctx.inbox.markRead(input.workspaceId, input.projectId, ctx.session.user.id, input.conversationId);
    return { ok: true } as const;
  }),

  setContactBlocked: messengerProcedure
    .input(projectInput.extend({ contactId: z.uuid(), blocked: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.inbox.setContactBlocked(input.workspaceId, input.projectId, ctx.session.user.id, input);
      return { ok: true } as const;
    }),

  /** Erase the contact and everything they wrote (a privacy request). */
  eraseContact: messengerProcedure
    .input(projectInput.extend({ contactId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.inbox.eraseContact(input.workspaceId, input.projectId, ctx.session.user.id, input.contactId);
      return { ok: true } as const;
    }),
});
