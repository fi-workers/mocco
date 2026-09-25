// Notification router (relay design §9) — thin: parse at the boundary (zod from
// @mocco/common/notification), delegate to ChannelService, and map this domain's error
// families here. Reads require membership; writes require an owner or admin. Outputs
// go through `.output()`, which strips `secret_sealed`, `external_id` and workspace ids.
import {
  DELIVERY_LIST_MAX,
  channelTestResultSchema,
  deliveryStatusSchema,
  discordGuildSchema,
  discordTextChannelSchema,
  notificationChannelSchema,
  notificationDeliverySchema,
  notificationRuleSchema,
  ruleEventTypeSchema,
  ruleFilterSchema,
  rulePresetSchema,
} from '@mocco/common/notification';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@backend/domain/errors';
import { protectedProcedure, router } from '@backend/transport/trpc/trpc';

const workspaceScopedInput = z.object({ workspaceId: z.uuid() });

/** Re-raise a notification-domain (or workspace) error family as its tRPC code; a no-op otherwise. */
const rethrowNotificationError = (cause: unknown): void => {
  if (cause instanceof NotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: cause.message, cause });
  }
  if (cause instanceof ForbiddenError) {
    throw new TRPCError({ code: 'FORBIDDEN', message: cause.message, cause });
  }
  if (cause instanceof ConflictError) {
    throw new TRPCError({ code: 'CONFLICT', message: cause.message, cause });
  }
  if (cause instanceof BadRequestError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: cause.message, cause });
  }
};

const check = async (run: () => Promise<unknown>): Promise<void> => {
  try {
    await run();
  } catch (error) {
    rethrowNotificationError(error);
    throw error;
  }
};

/** Requires the notification service and maps this domain's errors from the resolver. */
const notificationProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  const { notifications } = ctx;
  if (notifications === undefined) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Notifications are not available' });
  }
  const result = await next({ ctx: { ...ctx, notifications } });
  if (!result.ok) {
    rethrowNotificationError(result.error.cause);
  }
  return result;
});

/** Members of `workspaceId` (a non-member gets NOT_FOUND before any resolver runs). */
const protectedNotificationProcedure = notificationProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = workspaceScopedInput.parse(await getRawInput());
  await check(async () => {
    await ctx.workspace.assertMember(ctx.headers, workspaceId);
  });
  return await next();
});

/** Owners and admins of `workspaceId`: a plain member gets FORBIDDEN, a non-member
 * NOT_FOUND (`assertAdmin` implies membership). */
const adminNotificationProcedure = notificationProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = workspaceScopedInput.parse(await getRawInput());
  await check(async () => {
    await ctx.workspace.assertAdmin(ctx.headers, workspaceId);
  });
  return await next();
});

const channelInput = workspaceScopedInput.extend({ channelId: z.uuid() });

export const notificationRouter = router({
  guilds: protectedNotificationProcedure
    .input(workspaceScopedInput)
    .output(z.object({ guilds: z.array(discordGuildSchema) }))
    .query(async ({ ctx, input }) => ({ guilds: await ctx.notifications.listGuilds(input.workspaceId) })),

  // Admin-only: it spends Discord API calls on the shared bot.
  guildChannels: adminNotificationProcedure
    .input(workspaceScopedInput.extend({ guildId: z.uuid() }))
    .output(z.object({ channels: z.array(discordTextChannelSchema) }))
    .query(async ({ ctx, input }) => ({
      channels: await ctx.notifications.listGuildChannels(input.workspaceId, input.guildId),
    })),

  channels: protectedNotificationProcedure
    .input(workspaceScopedInput)
    .output(z.object({ channels: z.array(notificationChannelSchema) }))
    .query(async ({ ctx, input }) => ({ channels: await ctx.notifications.listChannels(input.workspaceId) })),

  createChannel: adminNotificationProcedure
    .input(
      workspaceScopedInput.extend({
        guildId: z.uuid(),
        channelId: z.string().regex(/^\d{1,20}$/u),
        name: z.string().trim().min(1).max(100).optional(),
      }),
    )
    .output(z.object({ channel: notificationChannelSchema, test: channelTestResultSchema }))
    .mutation(
      async ({ ctx, input }) =>
        await ctx.notifications.createChannel(input.workspaceId, {
          guildId: input.guildId,
          channelId: input.channelId,
          name: input.name,
        }),
    ),

  deleteChannel: adminNotificationProcedure.input(channelInput).mutation(async ({ ctx, input }) => {
    await ctx.notifications.deleteChannel(input.workspaceId, input.channelId);
  }),

  reenableChannel: adminNotificationProcedure
    .input(channelInput)
    .output(z.object({ channel: notificationChannelSchema, test: channelTestResultSchema }))
    .mutation(async ({ ctx, input }) => await ctx.notifications.reenableChannel(input.workspaceId, input.channelId)),

  rules: protectedNotificationProcedure
    .input(channelInput)
    .output(z.object({ rules: z.array(notificationRuleSchema) }))
    .query(async ({ ctx, input }) => ({
      rules: await ctx.notifications.listRules(input.workspaceId, input.channelId),
    })),

  addRule: adminNotificationProcedure
    .input(
      channelInput.extend({
        eventType: ruleEventTypeSchema,
        sourceId: z.uuid().nullish(),
        filter: ruleFilterSchema.optional(),
      }),
    )
    .output(z.object({ rule: notificationRuleSchema }))
    .mutation(async ({ ctx, input }) => ({
      rule: await ctx.notifications.addRule(input.workspaceId, input.channelId, {
        eventType: input.eventType,
        sourceId: input.sourceId ?? null,
        filter: input.filter,
      }),
    })),

  removeRule: adminNotificationProcedure
    .input(workspaceScopedInput.extend({ ruleId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.notifications.removeRule(input.workspaceId, input.ruleId);
    }),

  applyDefaultRules: adminNotificationProcedure
    .input(channelInput.extend({ preset: rulePresetSchema, sourceId: z.uuid().nullish() }))
    .output(z.object({ rules: z.array(notificationRuleSchema) }))
    .mutation(async ({ ctx, input }) => ({
      rules: await ctx.notifications.applyDefaultRules(
        input.workspaceId,
        input.channelId,
        input.preset,
        input.sourceId,
      ),
    })),

  deliveries: protectedNotificationProcedure
    .input(
      workspaceScopedInput.extend({
        channelId: z.uuid().optional(),
        status: deliveryStatusSchema.optional(),
        limit: z.int().min(1).max(DELIVERY_LIST_MAX).optional(),
      }),
    )
    .output(z.object({ deliveries: z.array(notificationDeliverySchema) }))
    .query(async ({ ctx, input }) => ({
      deliveries: await ctx.notifications.listDeliveries(input.workspaceId, {
        channelId: input.channelId,
        status: input.status,
        limit: input.limit,
      }),
    })),
});
