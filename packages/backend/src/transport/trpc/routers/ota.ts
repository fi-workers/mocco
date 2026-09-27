// OTA router — thin: version policy and native force update for a project's store apps
// (phase 2 of the OTA release control design). Every procedure requires the OTA product
// to be enabled and the project to belong to the workspace (`productProcedure`), which
// also maps the project domain's error family; OTA errors extend the same bases.
import {
  otaExternalCredentialCreateInputSchema,
  otaExternalCredentialSchema,
  VersionPolicyOutcomes,
  versionPolicyChangeInputSchema,
  versionPolicyChangeSchema,
  versionPolicySchema,
} from '@mocco/common/ota';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const appInput = projectInput.extend({ appId: z.uuid() });
const otaProcedure = productProcedure(Products.ota);

export const otaRouter = router({
  versionPolicy: router({
    get: otaProcedure
      .input(appInput)
      .output(z.object({ policy: versionPolicySchema.nullable() }))
      .query(async ({ ctx, input }) => ({
        policy: await ctx.versionPolicies.get(input.workspaceId, input.projectId, input.appId),
      })),

    change: otaProcedure
      .input(appInput.extend(versionPolicyChangeInputSchema.shape))
      .output(
        z.object({
          outcome: z.enum([VersionPolicyOutcomes.applied, VersionPolicyOutcomes.pendingApproval]),
          policy: versionPolicySchema.nullable(),
          /** The pre-approval (pending_approval) or the post-hoc review (applied relax change). */
          requestId: z.uuid().nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const { workspaceId, projectId, appId, ...change } = input;
        return await ctx.versionPolicies.change(workspaceId, projectId, appId, ctx.session.user.id, change);
      }),

    history: otaProcedure
      .input(appInput)
      .output(z.object({ changes: z.array(versionPolicyChangeSchema) }))
      .query(async ({ ctx, input }) => ({
        changes: await ctx.versionPolicies.listChanges(input.workspaceId, input.projectId, input.appId),
      })),
  }),
  externalCredential: router({
    list: otaProcedure
      .input(projectInput)
      .output(z.object({ credentials: z.array(otaExternalCredentialSchema) }))
      .query(async ({ ctx, input }) => ({
        credentials: await ctx.externalCredentials.list(input.workspaceId, input.projectId),
      })),

    create: otaProcedure
      .input(projectInput.extend(otaExternalCredentialCreateInputSchema.shape))
      .output(z.object({ credential: otaExternalCredentialSchema }))
      .mutation(async ({ ctx, input }) => {
        const { workspaceId, projectId, ...values } = input;
        return {
          credential: await ctx.externalCredentials.create(workspaceId, projectId, ctx.session.user.id, values),
        };
      }),

    rotate: otaProcedure
      .input(projectInput.extend({ credentialId: z.uuid(), secret: z.string().min(1).max(8192) }))
      .output(z.object({ credential: otaExternalCredentialSchema }))
      .mutation(async ({ ctx, input }) => ({
        credential: await ctx.externalCredentials.rotate(
          input.workspaceId,
          input.projectId,
          ctx.session.user.id,
          input.credentialId,
          input.secret,
        ),
      })),

    delete: otaProcedure.input(projectInput.extend({ credentialId: z.uuid() })).mutation(async ({ ctx, input }) => {
      await ctx.externalCredentials.delete(input.workspaceId, input.projectId, ctx.session.user.id, input.credentialId);
      return { ok: true } as const;
    }),
  }),
});
