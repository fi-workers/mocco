import { z } from 'zod';

/** Adapter-specific options — free-form by contract (ADR 0004); the core never interprets these. */
export const stepWithSchema = z.record(z.string(), z.unknown());

/** A pipeline step. `run` is a label; `executor` is an opaque adapter id (no enum). */
export const stepSchema = z
  .object({ run: z.string().min(1), executor: z.string().min(1), with: stepWithSchema.optional() })
  .strict();
export type Step = z.infer<typeof stepSchema>;

/** A pipeline item. v1: only steps. Gates land as `version: 2` with an explicit
 * `kind` discriminator (ADR 0010) — NOT a bare union on `run`/`gate` (which zod
 * can't discriminate and whose errors double). The `run`-based uniqueness check
 * below moves to an effective id (`id ?? run ?? gate`) in that same change. */
export const pipelineItemSchema = stepSchema;
export type PipelineItem = z.infer<typeof pipelineItemSchema>;

export const moccoConfigSchema = z
  .object({ version: z.literal(1), pipeline: z.string().min(1), steps: z.array(pipelineItemSchema).min(1) })
  .strict()
  .superRefine((cfg, ctx) => {
    const names = cfg.steps.map(s => s.run);
    const duplicates = [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
    if (duplicates.length > 0) {
      ctx.addIssue({ code: 'custom', message: `duplicate step name(s): ${duplicates.join(', ')}`, path: ['steps'] });
    }
  });
export type MoccoConfig = z.infer<typeof moccoConfigSchema>;
