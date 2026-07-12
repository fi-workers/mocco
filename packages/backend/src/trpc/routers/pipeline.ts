// Pipeline domain router — thin by convention: parse at the boundary (zod
// from @mocco/common), resolve the active workspace, delegate to the injected
// service, map domain errors.
import { pipelineSchema, pipelineVersionSchema } from '@mocco/common/pipeline';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { MoccoConfigSchemaError, MoccoConfigYamlError } from '../../pipeline/errors';
import { router, protectedProcedure } from '../trpc';

import type { Context } from '../trpc';
import type { MoccoConfig } from '@mocco/common/mocco-config';

/** The `definition` jsonb column is stored `unknown` at the type level; it was
 * validated against `MoccoConfig` by the parser before insert (PipelineService),
 * and `.output()` re-validates it against the same schema on the wire. */
function withTypedDefinition<T extends { definition: unknown }>(
  version: T,
): Omit<T, 'definition'> & { definition: MoccoConfig } {
  return { ...version, definition: version.definition as MoccoConfig };
}

/** The session-active workspace, or throws PRECONDITION_FAILED when none is active. */
async function requireActiveWorkspace(ctx: Context) {
  const active = await ctx.workspace.getActive(ctx.headers);
  if (!active) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'no active workspace' });
  return active;
}

export const pipelineRouter = router({
  submit: protectedProcedure
    .input(z.object({ source: z.string() }))
    .output(z.object({ pipeline: pipelineSchema }))
    .mutation(async ({ ctx, input }) => {
      const active = await requireActiveWorkspace(ctx);
      try {
        const { pipeline } = await ctx.pipeline.submit(active.id, input.source);
        return { pipeline };
      } catch (error) {
        if (error instanceof MoccoConfigSchemaError || error instanceof MoccoConfigYamlError) {
          throw new TRPCError({ code: 'BAD_REQUEST', cause: error });
        }
        throw error;
      }
    }),

  list: protectedProcedure.output(z.object({ pipelines: z.array(pipelineSchema) })).query(async ({ ctx }) => {
    const active = await requireActiveWorkspace(ctx);
    return { pipelines: await ctx.pipeline.list(active.id) };
  }),

  get: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .output(z.object({ pipeline: pipelineSchema, version: pipelineVersionSchema.nullable() }))
    .query(async ({ ctx, input }) => {
      const active = await requireActiveWorkspace(ctx);
      const result = await ctx.pipeline.get(active.id, input.id);
      if (!result) throw new TRPCError({ code: 'NOT_FOUND' });
      return { pipeline: result.pipeline, version: result.version && withTypedDefinition(result.version) };
    }),
});
