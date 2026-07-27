import { z } from 'zod';

/**
 * Governance access shapes (slice 5, PR1), defined once as zod schemas (the single
 * type source) and used as the tRPC `.output()` egress filter. The `*Dto` types are
 * the wire shape (`z.infer`, post-parse) — the contract clients consume; router
 * outputs wrap them in an envelope (`{ role }` / `{ roles }` / `{ members }`).
 *
 * Gate/resume DTOs (`runGateSchema`, `resumeSchema`) land in later PRs of this
 * slice — not here.
 */
export const roleSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  name: z.string(),
  createdAt: z.date(),
});
export type RoleDto = z.infer<typeof roleSchema>;

/**
 * A role membership with the joined user (name/email) — the shape the Access page's
 * per-role member list needs. The egress filter strips the vendor row's other
 * columns and `user.image`, which the list doesn't use.
 */
export const roleMemberSchema = z.object({
  id: z.uuid(),
  roleId: z.uuid(),
  userId: z.uuid(),
  createdAt: z.date(),
  // `name` is nullable: a joined mocco_users row may have no display name set
  // (unlike the vendor-mediated workspace member, which guarantees one).
  user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string() }),
});
export type RoleMemberDto = z.infer<typeof roleMemberSchema>;

/** Create-role input: a non-empty name, bounded like the workspace name. */
export const roleCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
});
export type RoleCreateInput = z.infer<typeof roleCreateInputSchema>;
