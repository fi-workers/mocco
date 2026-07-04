import { z } from 'zod';

/** .mocco.yml schema (mirrors docs/reference/mocco.schema.json) — ADR 0003 */
export const credential = z.object({
  provider: z.enum(['aws-oidc', 'gcp-oidc', 'azure-oidc', 'vault']),
  role: z.string().min(1),
  ttl: z
    .string()
    .regex(/^\d+[smh]$/)
    .optional(),
});

export const step = z.object({
  run: z.string().min(1),
  executor: z.string().min(1),
  with: z.record(z.string(), z.unknown()).optional(),
  credential: credential.optional(),
});

/** pause/resume gate — resume is role-based (AND of role×count) */
export const gate = z.object({
  gate: z.string().min(1),
  resume: z.array(z.object({ role: z.string().min(1), count: z.number().int().min(1) })).min(1),
  prevent_self: z.boolean().default(true),
  reason_required: z.boolean().default(false),
});

export const moccoYml = z.object({
  version: z.literal(1),
  pipeline: z.string().min(1),
  steps: z.array(z.union([step, gate])).min(1),
  concurrency: z
    .object({
      group: z.string().optional(),
      mode: z.enum(['oldest_first', 'newest_first', 'newest_ready_first', 'unordered']).optional(),
    })
    .optional(),
  safety: z.object({ prevent_outdated: z.enum(['reject', 'skip', 'off']).optional() }).optional(),
  audit: z.object({ hash_chain: z.boolean().optional() }).optional(),
});

export type MoccoYml = z.infer<typeof moccoYml>;
export type Gate = z.infer<typeof gate>;
export type Step = z.infer<typeof step>;
