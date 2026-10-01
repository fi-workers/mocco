import { z } from 'zod';

/**
 * API keys for the public `/v1` surface (ADR 0017). A key belongs to one project.
 * Publishable keys (`mk_pub_…`) are embedded in web and React Native apps and carry
 * only client scopes; secret keys (`mk_sec_…`) stay on servers and are refused from a
 * browser. Only a SHA-256 of the token is stored; the token is shown once.
 */
export const ApiKeyKinds = {
  publishable: 'publishable',
  secret: 'secret',
} as const;
export type ApiKeyKind = (typeof ApiKeyKinds)[keyof typeof ApiKeyKinds];
export const apiKeyKindSchema = z.enum([ApiKeyKinds.publishable, ApiKeyKinds.secret]);

/** The token prefix of each kind. */
export const ApiKeyPrefixes = {
  [ApiKeyKinds.publishable]: 'mk_pub_',
  [ApiKeyKinds.secret]: 'mk_sec_',
} as const satisfies Record<ApiKeyKind, string>;

/** What a key may do. Products add their scopes here as their `/v1` routes land. */
export const ApiScopes = {
  otaRead: 'ota:read',
  otaWrite: 'ota:write',
  flagsRead: 'flags:read',
  flagsWrite: 'flags:write',
} as const;
export type ApiScope = (typeof ApiScopes)[keyof typeof ApiScopes];
export const apiScopeSchema = z.enum(Object.values(ApiScopes) as [ApiScope, ...ApiScope[]]);

/** Scopes a publishable key may hold: reads a client app needs, nothing that changes state. */
export const PUBLISHABLE_SCOPES: readonly ApiScope[] = [ApiScopes.otaRead, ApiScopes.flagsRead];

/** A key as the console lists it — never the token or its hash. */
export const apiKeySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: apiKeyKindSchema,
  name: z.string(),
  /** `mk_pub_…abcd`: the prefix and the last four characters, for recognising a key. */
  hint: z.string(),
  scopes: z.array(apiScopeSchema),
  createdByUserId: z.uuid().nullable(),
  createdAt: z.date(),
  lastUsedAt: z.date().nullable(),
  expiresAt: z.date().nullable(),
  revokedAt: z.date().nullable(),
});
export type ApiKeyDto = z.infer<typeof apiKeySchema>;

export const apiKeyCreateInputSchema = z
  .object({
    kind: apiKeyKindSchema,
    name: z.string().min(1).max(80),
    scopes: z.array(apiScopeSchema).min(1).max(20),
    expiresAt: z.date().nullable().default(null),
  })
  .refine(
    input => input.kind === ApiKeyKinds.secret || input.scopes.every(scope => PUBLISHABLE_SCOPES.includes(scope)),
    {
      message: 'A publishable key can only hold client scopes',
      path: ['scopes'],
    },
  );
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateInputSchema>;

/** `GET /v1/whoami`: the project and scopes a key speaks for. */
export const whoamiResponseSchema = z.object({
  projectId: z.uuid(),
  kind: z.enum([ApiKeyKinds.publishable, ApiKeyKinds.secret]),
  scopes: z.array(z.enum(Object.values(ApiScopes) as [ApiScope, ...ApiScope[]])),
});
