import { z } from 'zod';

export const workspaceCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
});
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateInputSchema>;

/**
 * Workspace shapes, defined once as zod schemas (the single type source).
 * The schemas are the tRPC `.output()` egress filter: they strip unknown vendor
 * fields (the vendor row carries `metadata` and the system `slug`) and normalize
 * (logo → `string | null`). The `*Dto` types are the wire shape (`z.output`,
 * i.e. post-parse) — the contract clients consume; router outputs wrap them in
 * an envelope (`{ workspace }` / `{ workspaces }`). Services return the raw
 * vendor rows and are not annotated with the Dto (pre-parse, the vendor's `logo`
 * is still `string | undefined | null`) — the `.output()` filter is the boundary.
 *
 * `slug` is deliberately absent: the vendor requires the column, but Mocco
 * fills it with a system-generated uuid (WorkspaceService.create) that carries
 * no product meaning, so it never crosses the wire — the egress filter strips it.
 */
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  logo: z
    .string()
    .nullish()
    .transform(value => value ?? null),
  createdAt: z.date(),
});
export type WorkspaceDto = z.infer<typeof workspaceSchema>;

export const workspaceMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: z.date(),
});
export type WorkspaceMemberDto = z.infer<typeof workspaceMemberSchema>;

/**
 * A workspace member with the joined user (name/email) — the shape the members
 * list needs. The egress filter strips the vendor's `organizationId` and
 * `user.image`, which the list doesn't use.
 */
export const workspaceMemberDetailSchema = workspaceMemberSchema.extend({
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }),
});
export type WorkspaceMemberDetailDto = z.infer<typeof workspaceMemberDetailSchema>;
