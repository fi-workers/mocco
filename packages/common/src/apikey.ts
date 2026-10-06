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
  /** Read runs and their steps and gates. Read-only by design: a key is a project, not a
   * person, and resuming or approving must name someone who could have been asked
   * (ADR 0002, ADR 0025). */
  runsRead: 'runs:read',
  otaRead: 'ota:read',
  otaWrite: 'ota:write',
  flagsRead: 'flags:read',
  flagsWrite: 'flags:write',
  /** Start and continue conversations as the app's users (#95); every call also needs
   * the user's identity signed by the app's server. */
  messengerChat: 'messenger:chat',
  /** Search the project's published help center (#96), e.g. to suggest articles in an app. */
  helpRead: 'help:read',
  /** Ask for an ad-hoc round of one of the project's monitors (#155), e.g. from a pipeline step
   * after a deploy, and manage its monitors, incidents, maintenance and component statuses as
   * code (#159). Secret keys only: it makes Mocco send requests to the monitor's target. */
  statusWrite: 'status:write',
  /** Read the project's monitors, incidents (drafts too), maintenance and components (#159).
   * Secret keys only: draft incidents and monitor settings are operational data. */
  statusRead: 'status:read',
  /** Read the project's public feedback boards (#174): boards, posts, the roadmap and public
   * comments. Private boards, internal notes and the team's ids are never served. */
  feedbackRead: 'feedback:read',
  /** Vote and comment on the project's public boards as the app's users (#174); every call also
   * needs the user's token, signed by the app's server. */
  feedbackWrite: 'feedback:write',
} as const;
export type ApiScope = (typeof ApiScopes)[keyof typeof ApiScopes];
export const apiScopeSchema = z.enum(Object.values(ApiScopes) as [ApiScope, ...ApiScope[]]);

/** Scopes a publishable key may hold: reads a client app needs, and messenger chat and feedback
 * writes, which act only for a user whose identity the app's server signed. Nothing else
 * changes state. */
export const PUBLISHABLE_SCOPES: readonly ApiScope[] = [
  ApiScopes.otaRead,
  ApiScopes.flagsRead,
  ApiScopes.messengerChat,
  ApiScopes.helpRead,
  ApiScopes.feedbackRead,
  ApiScopes.feedbackWrite,
];

/** A key as the console lists it — never the token or its hash. */
export const apiKeySchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  kind: apiKeyKindSchema,
  name: z.string(),
  /** `mk_pub_…abcd`: the prefix and the last four characters, for recognising a key. */
  hint: z.string(),
  scopes: z.array(apiScopeSchema),
  /** The flag environment a `flags:read` key reads (ADR 0024: one key, one ruleset). */
  flagEnvironmentId: z.uuid().nullable(),
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
    /** Required with `flags:read`, refused without it. */
    flagEnvironmentId: z.uuid().nullable().default(null),
  })
  .refine(
    input => input.kind === ApiKeyKinds.secret || input.scopes.every(scope => PUBLISHABLE_SCOPES.includes(scope)),
    {
      message: 'A publishable key can only hold client scopes',
      path: ['scopes'],
    },
  )
  .refine(input => input.scopes.includes(ApiScopes.flagsRead) === (input.flagEnvironmentId !== null), {
    message: 'A key with flags:read reads exactly one flag environment; other keys name none',
    path: ['flagEnvironmentId'],
  });
export type ApiKeyCreateInput = z.infer<typeof apiKeyCreateInputSchema>;

/** `GET /v1/whoami`: the project and scopes a key speaks for. */
export const whoamiResponseSchema = z.object({
  projectId: z.uuid(),
  kind: z.enum([ApiKeyKinds.publishable, ApiKeyKinds.secret]),
  scopes: z.array(z.enum(Object.values(ApiScopes) as [ApiScope, ...ApiScope[]])),
});
