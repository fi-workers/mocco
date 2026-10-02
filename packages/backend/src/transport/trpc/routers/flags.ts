// Flags router — thin: environments, flag definitions and immediate changesets of a
// project (#137). Every procedure requires the flags product to be enabled and the
// project to belong to the workspace (`productProcedure`), which also maps the project
// domain's error family; flag errors extend the same bases.
import {
  booleanFlagCreateInputSchema,
  ChangeOutcomes,
  changeOpSchema,
  changesetSchema,
  flagConfigSchema,
  flagEnvironmentCreateInputSchema,
  flagCreateInputSchema,
  flagEnvironmentSchema,
  flagSchema,
  flagSegmentSchema,
} from '@mocco/common/flags';
import { ApprovalDecisions, gateRequirementsSchema } from '@mocco/common/governance';
import { Products } from '@mocco/common/project';
import { z } from 'zod';

import { productProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const projectInput = z.object({ workspaceId: z.uuid(), projectId: z.uuid() });
const environmentInput = projectInput.extend({ environmentId: z.uuid() });
const flagsProcedure = productProcedure(Products.flags);

export const flagsRouter = router({
  environments: flagsProcedure
    .input(projectInput)
    .output(z.object({ environments: z.array(flagEnvironmentSchema) }))
    .query(async ({ ctx, input }) => ({
      environments: await ctx.flags.listEnvironments(input.workspaceId, input.projectId),
    })),

  createEnvironment: flagsProcedure
    .input(projectInput.extend(flagEnvironmentCreateInputSchema.shape))
    .output(z.object({ environment: flagEnvironmentSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...values } = input;
      return { environment: await ctx.flags.createEnvironment(workspaceId, projectId, ctx.session.user.id, values) };
    }),

  list: flagsProcedure
    .input(projectInput)
    .output(z.object({ flags: z.array(flagSchema.extend({ configs: z.array(flagConfigSchema) })) }))
    .query(async ({ ctx, input }) => ({ flags: await ctx.flags.listFlags(input.workspaceId, input.projectId) })),

  createBoolean: flagsProcedure
    .input(projectInput.extend(booleanFlagCreateInputSchema.shape))
    .output(z.object({ flag: flagSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...values } = input;
      return { flag: await ctx.flags.createBooleanFlag(workspaceId, projectId, ctx.session.user.id, values) };
    }),

  create: flagsProcedure
    .input(z.object({ workspaceId: z.uuid(), projectId: z.uuid(), flag: flagCreateInputSchema }))
    .output(z.object({ flag: flagSchema }))
    .mutation(async ({ ctx, input }) => ({
      flag: await ctx.flags.createFlag(input.workspaceId, input.projectId, ctx.session.user.id, input.flag),
    })),

  segments: flagsProcedure
    .input(environmentInput)
    .output(z.object({ segments: z.array(flagSegmentSchema) }))
    .query(async ({ ctx, input }) => ({
      segments: await ctx.flags.listSegments(input.workspaceId, input.projectId, input.environmentId),
    })),

  /** Evaluate every flag of the environment for a context, optionally with unsaved ops applied. */
  preview: flagsProcedure
    .input(
      environmentInput.extend({
        ops: z.array(changeOpSchema).max(100).default([]),
        context: z.record(z.string(), z.unknown()),
      }),
    )
    .output(
      z.object({
        results: z.array(
          z.object({
            flagKey: z.string(),
            value: z.unknown(),
            variant: z.string().nullable(),
            reason: z.string(),
            errorCode: z.string().nullable(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...preview } = input;
      return { results: await ctx.flags.preview(workspaceId, projectId, preview) };
    }),

  applyChangeset: flagsProcedure
    .input(
      environmentInput.extend({
        baseVersion: z.number().int().min(0),
        ops: z.array(changeOpSchema).min(1).max(100),
        reason: z.string().max(500).nullable().default(null),
      }),
    )
    .output(
      z.object({
        outcome: z.enum([ChangeOutcomes.applied, ChangeOutcomes.pendingApproval]),
        changeset: changesetSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...change } = input;
      return await ctx.flags.applyChangeset(workspaceId, projectId, ctx.session.user.id, change);
    }),

  /** A changeset with the votes cast on it so far. */
  changeset: flagsProcedure
    .input(projectInput.extend({ changesetId: z.uuid() }))
    .output(
      z.object({
        changeset: changesetSchema,
        votes: z.array(
          z.object({
            userId: z.uuid(),
            decision: z.enum([ApprovalDecisions.approve, ApprovalDecisions.reject]),
            reason: z.string().nullable(),
            createdAt: z.date(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { changeset } = await ctx.flagGovernance.requireChangeset(
        input.workspaceId,
        input.projectId,
        input.changesetId,
      );
      const request =
        changeset.approvalRequestId === null
          ? null
          : await ctx.approvals.get(input.workspaceId, changeset.approvalRequestId);
      const votes =
        request === null
          ? []
          : request.votes.map(vote => ({
              userId: vote.userId,
              decision: vote.decision,
              reason: vote.reason,
              createdAt: vote.createdAt,
            }));
      return { changeset, votes };
    }),

  /** Approve or reject a pending changeset; `contentHash` is the hash the voter reviewed. */
  voteChangeset: flagsProcedure
    .input(
      projectInput.extend({
        changesetId: z.uuid(),
        contentHash: z.string(),
        decision: z.enum([ApprovalDecisions.approve, ApprovalDecisions.reject]),
        reason: z.string().max(500).optional(),
      }),
    )
    .output(z.object({ changeset: changesetSchema }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...vote } = input;
      return { changeset: await ctx.flagGovernance.vote(workspaceId, projectId, ctx.session.user.id, vote) };
    }),

  withdrawChangeset: flagsProcedure
    .input(projectInput.extend({ changesetId: z.uuid() }))
    .output(z.object({ changeset: changesetSchema }))
    .mutation(async ({ ctx, input }) => ({
      changeset: await ctx.flagGovernance.withdraw(
        input.workspaceId,
        input.projectId,
        ctx.session.user.id,
        input.changesetId,
      ),
    })),

  /** Propose a pending or conflicted changeset's ops again on the current version (votes reset). */
  rebaseChangeset: flagsProcedure
    .input(projectInput.extend({ changesetId: z.uuid() }))
    .output(z.object({ changeset: changesetSchema }))
    .mutation(async ({ ctx, input }) => {
      const { changeset } = await ctx.flagGovernance.rebase(
        input.workspaceId,
        input.projectId,
        ctx.session.user.id,
        input.changesetId,
      );
      return { changeset };
    }),

  /** Kill a flag in an environment now, bypassing its gate (audited; reviewed afterwards if protected). */
  kill: flagsProcedure
    .input(environmentInput.extend({ flagKey: z.string(), reason: z.string().min(1).max(500) }))
    .output(z.object({ changeset: changesetSchema, reviewRequestId: z.uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...kill } = input;
      return await ctx.flagKillSwitch.kill(workspaceId, projectId, ctx.session.user.id, kill);
    }),

  /** Who may kill flags in an environment (workspace owners and admins set it). */
  setKillRoles: flagsProcedure
    .input(environmentInput.extend({ roles: z.array(z.string().min(1).max(80)).max(20) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.workspace.assertAdmin(ctx.headers, input.workspaceId);
      const { workspaceId, projectId, ...roles } = input;
      await ctx.flagKillSwitch.setKillRoles(workspaceId, projectId, ctx.session.user.id, roles);
      return { ok: true } as const;
    }),

  /** Protect, re-gate or unprotect an environment. A protected one's gate changes need its current gate. */
  setChangeGate: flagsProcedure
    .input(environmentInput.extend({ gate: gateRequirementsSchema.nullable() }))
    .output(
      z.object({
        outcome: z.enum([ChangeOutcomes.applied, ChangeOutcomes.pendingApproval]),
        requestId: z.uuid().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspaceId, projectId, ...change } = input;
      return await ctx.flagGovernance.setChangeGate(workspaceId, projectId, ctx.session.user.id, change);
    }),

  history: flagsProcedure
    .input(environmentInput)
    .output(z.object({ changesets: z.array(changesetSchema) }))
    .query(async ({ ctx, input }) => ({
      changesets: await ctx.flags.history(input.workspaceId, input.projectId, input.environmentId),
    })),

  ruleset: flagsProcedure
    .input(environmentInput)
    .output(z.object({ version: z.number(), etag: z.string(), document: z.record(z.string(), z.unknown()) }))
    .query(async ({ ctx, input }) => {
      const snapshot = await ctx.flags.ruleset(input.workspaceId, input.projectId, input.environmentId);
      return { version: snapshot.version, etag: snapshot.etag, document: snapshot.document };
    }),
});
