// OTA hosting router (ADR 0021) — thin: a project's hosted OTA apps, their code-signing
// certificates, their channels and the releases CI uploaded. Mounted as `ota.hosting`. Every procedure requires the
// OTA product (`productProcedure`); adding or retiring a certificate also requires an
// owner or admin, because a certificate decides whose signatures devices accept.
import { gateRequirementsSchema } from '@mocco/common/governance';
import {
  ChannelPolicyOutcomes,
  otaAppSchema,
  otaChannelCreateInputSchema,
  otaChannelHeadSchema,
  otaChannelSchema,
  otaPlatformSchema,
  otaReleaseSchema,
  otaTrustPolicyInputSchema,
  otaTrustPolicySchema,
  promotionPreviewSchema,
  signingCertificateInputSchema,
  signingCertificateSchema,
} from '@mocco/common/ota-hosting';
import { Products } from '@mocco/common/project';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { ForbiddenError } from '@backend/domain/errors';
import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const appInput = projectInput.extend({ appId: z.uuid() });
const otaProcedure = productProcedure(Products.ota);

/** OTA procedures limited to owners and admins (FORBIDDEN for a plain member). */
const adminOtaProcedure = otaProcedure.use(async ({ ctx, getRawInput, next }) => {
  const { workspaceId } = projectInput.parse(await getRawInput());
  try {
    await ctx.workspace.assertAdmin(ctx.headers, workspaceId);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
    }
    throw error;
  }
  return await next();
});

export const otaHostingRouter = router({
  trustPolicies: router({
    list: otaProcedure
      .input(appInput)
      .output(z.object({ policies: z.array(otaTrustPolicySchema) }))
      .query(async ({ ctx, input }) => {
        const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
        return { policies: await ctx.otaTrustPolicies.list(app) };
      }),

    /** Trust a GitHub repository and ref to publish without a stored key (owners and admins). */
    create: adminOtaProcedure
      .input(appInput.extend(otaTrustPolicyInputSchema.shape))
      .output(z.object({ policy: otaTrustPolicySchema }))
      .mutation(async ({ ctx, input }) => {
        const { workspaceId, projectId, appId, ...policy } = input;
        const app = await ctx.otaHosting.requireApp(workspaceId, projectId, appId);
        return { policy: await ctx.otaTrustPolicies.create(app, ctx.session.user.id, policy) };
      }),

    delete: adminOtaProcedure.input(appInput.extend({ policyId: z.uuid() })).mutation(async ({ ctx, input }) => {
      const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
      await ctx.otaTrustPolicies.delete(app, ctx.session.user.id, input.policyId);
    }),
  }),

  releases: router({
    list: otaProcedure
      .input(appInput)
      .output(z.object({ releases: z.array(otaReleaseSchema) }))
      .query(async ({ ctx, input }) => {
        const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
        return { releases: await ctx.otaUploads.listReleases(app) };
      }),
  }),

  apps: router({
    list: otaProcedure
      .input(projectInput)
      .output(z.object({ apps: z.array(otaAppSchema) }))
      .query(async ({ ctx, input }) => ({ apps: await ctx.otaHosting.listApps(input.workspaceId, input.projectId) })),

    create: otaProcedure
      .input(projectInput.extend({ projectAppId: z.uuid() }))
      .output(z.object({ app: otaAppSchema }))
      .mutation(async ({ ctx, input }) => ({
        app: await ctx.otaHosting.createApp(
          input.workspaceId,
          input.projectId,
          ctx.session.user.id,
          input.projectAppId,
        ),
      })),
  }),

  certificates: router({
    list: otaProcedure
      .input(appInput)
      .output(z.object({ certificates: z.array(signingCertificateSchema) }))
      .query(async ({ ctx, input }) => {
        const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
        return { certificates: await ctx.otaSigning.list(app) };
      }),

    add: adminOtaProcedure
      .input(appInput.extend(signingCertificateInputSchema.shape))
      .output(z.object({ certificate: signingCertificateSchema }))
      .mutation(async ({ ctx, input }) => {
        const { workspaceId, projectId, appId, ...certificate } = input;
        const app = await ctx.otaHosting.requireApp(workspaceId, projectId, appId);
        return { certificate: await ctx.otaSigning.add(app, ctx.session.user.id, certificate) };
      }),

    retire: adminOtaProcedure.input(appInput.extend({ certificateId: z.uuid() })).mutation(async ({ ctx, input }) => {
      const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
      await ctx.otaSigning.retire(app, ctx.session.user.id, input.certificateId);
      return { ok: true } as const;
    }),
  }),

  channels: router({
    list: otaProcedure
      .input(appInput)
      .output(z.object({ channels: z.array(otaChannelSchema) }))
      .query(async ({ ctx, input }) => {
        const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
        return { channels: await ctx.otaHosting.listChannels(app) };
      }),

    create: otaProcedure
      .input(appInput.extend(otaChannelCreateInputSchema.shape))
      .output(z.object({ channel: otaChannelSchema }))
      .mutation(async ({ ctx, input }) => {
        const { workspaceId, projectId, appId, ...channel } = input;
        const app = await ctx.otaHosting.requireApp(workspaceId, projectId, appId);
        return { channel: await ctx.otaHosting.createChannel(app, ctx.session.user.id, channel) };
      }),

    changePolicy: otaProcedure
      .input(appInput.extend({ channelId: z.uuid(), policy: gateRequirementsSchema.nullable() }))
      .output(
        z.object({
          outcome: z.enum([ChannelPolicyOutcomes.applied, ChannelPolicyOutcomes.pendingApproval]),
          channel: otaChannelSchema,
          requestId: z.uuid().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
        return await ctx.otaHosting.changeChannelPolicy(app, ctx.session.user.id, input.channelId, input.policy);
      }),

    /** What promoting a release to a channel would change (the approval card's diff). */
    previewPromotion: otaProcedure
      .input(appInput.extend({ channelId: z.uuid(), releaseId: z.uuid() }))
      .output(promotionPreviewSchema)
      .query(async ({ ctx, input }) => {
        const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
        return await ctx.otaChannels.previewPromotion(app, input.channelId, input.releaseId);
      }),

    /** What each channel head serves now. */
    heads: otaProcedure
      .input(appInput)
      .output(z.object({ heads: z.array(otaChannelHeadSchema) }))
      .query(async ({ ctx, input }) => {
        const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
        return { heads: await ctx.otaChannels.listHeads(app) };
      }),

    /** Promote a ready release: at once to an open channel, as an approval request to a protected one. */
    promote: otaProcedure
      .input(
        appInput.extend({
          channelId: z.uuid(),
          releaseId: z.uuid(),
          reason: z.string().max(500).nullable().default(null),
        }),
      )
      .output(
        z.object({
          channel: z.string(),
          releaseId: z.uuid(),
          platforms: z.array(otaPlatformSchema),
          changed: z.boolean(),
          outcome: z.enum([ChannelPolicyOutcomes.applied, ChannelPolicyOutcomes.pendingApproval]),
          requestId: z.uuid().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const app = await ctx.otaHosting.requireApp(input.workspaceId, input.projectId, input.appId);
        return await ctx.otaChannels.promote(app, input.channelId, input.releaseId, ctx.session.user.id, input.reason);
      }),
  }),
});
