import { z } from 'zod';

/**
 * Credential-broker allowlist shapes (slice 7, PR1), defined once as zod schemas
 * (the single type source) and used as the tRPC `.output()` egress filter. A grant
 * is the workspace's AUTHORITY: it means "for this repo+pipeline, a step gated
 * behind `gateName` may receive `role` from `provider` for up to `maxTtlSeconds`."
 * The `.mocco.yml` `credential` field (mocco-config.ts) is only a request matched
 * against these rows; the pure `evaluateGrant` is the SSOT for that match.
 */
export const credentialGrantSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  repoId: z.uuid(),
  pipeline: z.string(),
  gateName: z.string(),
  provider: z.string(),
  role: z.string(),
  maxTtlSeconds: z.number().int().positive(),
  createdAt: z.date(),
});
export type CredentialGrantDto = z.infer<typeof credentialGrantSchema>;

/** Create-grant input — the allowlist tuple plus its ttl ceiling. The workspace
 * scope (`workspaceId`) lives on the router's shared input, not here. */
export const credentialGrantCreateInputSchema = z.object({
  repoId: z.uuid(),
  pipeline: z.string().min(1),
  gateName: z.string().min(1),
  provider: z.string().min(1),
  role: z.string().min(1),
  maxTtlSeconds: z.number().int().positive(),
});
export type CredentialGrantCreateInput = z.infer<typeof credentialGrantCreateInputSchema>;
