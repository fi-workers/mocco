import { z } from 'zod';

/** Adapter-specific options — free-form by contract (ADR 0004); the core never interprets these. */
export const stepWithSchema = z.record(z.string(), z.unknown());

/** A pipeline step. `run` is a label; `executor` is an opaque adapter id (no enum). */
export const stepSchema = z
  .object({ run: z.string().min(1), executor: z.string().min(1), with: stepWithSchema.optional() })
  .strict();
export type Step = z.infer<typeof stepSchema>;

/** One N-of-M requirement on a gate: `count` distinct principals holding `role` must
 * resume. Kept self-contained (structurally mirrors the pure evaluator's
 * `GateRequirement`) so the config schema and the invariant can evolve independently. */
export const requirementSchema = z.object({ role: z.string().min(1), count: z.number().int().positive() });
export type Requirement = z.infer<typeof requirementSchema>;

/** The pipeline-item `kind` discriminator values (ADR 0010) — the SSOT referenced by
 * the schema literals and every `item.kind` comparison (no magic strings). */
export const PipelineItemKinds = { step: 'step', gate: 'gate' } as const;
export type PipelineItemKind = (typeof PipelineItemKinds)[keyof typeof PipelineItemKinds];

/** A step's runtime **request** for cloud credentials from the broker (slice 7).
 * It is only a request: the workspace allowlist (`mocco_credential_grants`) is the
 * authority, so a repo author can't self-grant anything the workspace hasn't already
 * permitted. `gate` names the dominating gate whose resume the broker requires
 * before issuing (see the v2 `superRefine` lint). `ttl` is in seconds. */
export const credentialSchema = z
  .object({
    provider: z.string().min(1),
    role: z.string().min(1),
    ttl: z.number().int().positive(),
    gate: z.string().min(1),
  })
  .strict();
export type Credential = z.infer<typeof credentialSchema>;

/** v2 step item — a `stepSchema` tagged with the `kind` discriminator (ADR 0010),
 * optionally requesting broker-issued credentials behind a named gate. */
export const stepItemSchema = stepSchema
  .extend({ kind: z.literal(PipelineItemKinds.step), credential: credentialSchema.optional() })
  .strict();
export type StepItem = z.infer<typeof stepItemSchema>;

/** v2 gate item — a pause point resumed under N-of-M AND role requirements, with
 * optional `prevent_self` (the triggerer can't self-approve) and `reason_required`. */
export const gateItemSchema = z
  .object({
    kind: z.literal(PipelineItemKinds.gate),
    name: z.string().min(1),
    resume: z.array(requirementSchema).min(1),
    prevent_self: z.boolean().optional(),
    reason_required: z.boolean().optional(),
  })
  .strict();
export type GateItem = z.infer<typeof gateItemSchema>;

/** A v2 pipeline item: a step or a gate, discriminated on `kind` (ADR 0010) — NOT a
 * bare union on `run`/`gate` (which zod can't discriminate and whose errors double). */
export const pipelineItemSchema = z.discriminatedUnion('kind', [stepItemSchema, gateItemSchema]);
export type PipelineItem = z.infer<typeof pipelineItemSchema>;

/** v1: a flat list of steps (no gates). Kept as a plain object (the discriminated
 * union widens on `version`), so existing configs keep validating unchanged. */
const v1Schema = z
  .object({ version: z.literal(1), pipeline: z.string().min(1), steps: z.array(stepSchema).min(1) })
  .strict();

/** v2: the pipeline is a list of items, each a step or a gate (ADR 0010). */
const v2Schema = z
  .object({ version: z.literal(2), pipeline: z.string().min(1), steps: z.array(pipelineItemSchema).min(1) })
  .strict();

/** The effective id of an item for the duplicate check — a step's `run` label or a
 * gate's `name`. The v1 `run`-based check broke on gates (no `run`), so uniqueness
 * moved here (ADR 0010). A v1 item is always a step. */
function effectiveId(item: Step | PipelineItem): string {
  return 'kind' in item && item.kind === PipelineItemKinds.gate ? item.name : item.run;
}

/**
 * `.mocco.yml` schema: a discriminated union on `version` (ADR 0010). v1 is a flat
 * step list; v2 adds gate items. The duplicate-name check runs on the union result
 * (effective id per item) so a gate's `name` and a step's `run` share one namespace.
 */
export const moccoConfigSchema = z
  .discriminatedUnion('version', [v1Schema, v2Schema])
  .superRefine((cfg, ctx) => {
    const ids = cfg.steps.map(item => effectiveId(item));
    const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate step/gate name(s): ${duplicates.join(', ')}`,
        path: ['steps'],
      });
    }
  })
  // Fail-closed credential lint (slice 7): a step requesting credentials must name a
  // gate that DOMINATES it — in the linear v1 pipeline that means a `gate` item
  // appearing EARLIER in `steps`. This ties every credential request to a resume the
  // broker can require; a dangling `credential.gate` is rejected at parse time (v1
  // has no `credential`, so this only bites v2).
  .superRefine((cfg, ctx) => {
    if (cfg.version !== 2) {
      return;
    }
    // A step's credential.gate must name a gate that DOMINATES it — earlier in the
    // linear steps list. Collect every offender (like the duplicate check) and raise
    // one aggregated issue, so the functional passes stay side-effect-light.
    const offenders = cfg.steps.flatMap((item, index) => {
      if (item.kind !== PipelineItemKinds.step || item.credential === undefined) {
        return [];
      }
      const gateName = item.credential.gate;
      const earlierGateNames = cfg.steps
        .slice(0, index)
        .flatMap(prior => (prior.kind === PipelineItemKinds.gate ? [prior.name] : []));
      return earlierGateNames.includes(gateName) ? [] : [`"${item.run}" → "${gateName}"`];
    });
    if (offenders.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `credential.gate must name a gate item earlier in the pipeline: ${offenders.join(', ')}`,
        path: ['steps'],
      });
    }
  });
export type MoccoConfig = z.infer<typeof moccoConfigSchema>;
