// Approval router (#114) — thin: the approval queue a workspace member reads and votes
// on. Requests are opened by product domains through ApprovalService, never directly by
// a client, so there is no `create` procedure. Tenant checks and error mapping come from
// the shared workspace procedure (it maps by the shared error bases).
import {
  approvalKindSchema,
  approvalRequestSchema,
  approvalStateSchema,
  approvalVoteInputSchema,
  approvalVoteSchema,
} from '@mocco/common/governance';
import { z } from 'zod';

import { protectedWorkspaceProcedure } from '@backend/transport/trpc/project-procedures';
import { router } from '@backend/transport/trpc/trpc';

const workspaceInput = z.object({ workspaceId: z.uuid() });
const requestInput = workspaceInput.extend({ requestId: z.uuid() });
const detailOutput = z.object({ request: approvalRequestSchema, votes: z.array(approvalVoteSchema) });

export const approvalRouter = router({
  list: protectedWorkspaceProcedure
    .input(
      workspaceInput.extend({
        state: approvalStateSchema.optional(),
        kind: approvalKindSchema.optional(),
        subjectType: z.string().min(1).optional(),
        subjectId: z.string().min(1).optional(),
      }),
    )
    .output(z.object({ requests: z.array(approvalRequestSchema) }))
    .query(async ({ ctx, input }) => {
      const { workspaceId, ...filter } = input;
      return { requests: await ctx.approvals.list(workspaceId, filter) };
    }),

  get: protectedWorkspaceProcedure
    .input(requestInput)
    .output(detailOutput)
    .query(async ({ ctx, input }) => await ctx.approvals.get(input.workspaceId, input.requestId)),

  vote: protectedWorkspaceProcedure
    .input(requestInput.extend(approvalVoteInputSchema.shape))
    .output(detailOutput)
    .mutation(
      async ({ ctx, input }) =>
        await ctx.approvals.vote(input.workspaceId, input.requestId, ctx.session.user.id, input.decision, input.reason),
    ),
});
