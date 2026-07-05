import { z } from 'zod';

/** Slug rules shared by API input parsing and (later) frontend forms. */
export const workspaceSlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits and dashes only');

export const workspaceCreateInputSchema = z.object({
  name: z.string().min(1).max(80),
  slug: workspaceSlugSchema,
});
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateInputSchema>;

/**
 * Workspace shapes, defined once as zod schemas (the single type source):
 * - z.input (*Row) — the vendor-compatible pre-parse shape the backend returns
 *   internally (in-process consumers are trusted).
 * - z.output — the wire shape after the tRPC .output() egress filter strips
 *   unknown vendor fields and normalizes (e.g. logo → string | null).
 */
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  logo: z
    .string()
    .nullish()
    .transform(value => value ?? null),
  createdAt: z.date(),
});
export type WorkspaceRow = z.input<typeof workspaceSchema>;
export type Workspace = z.output<typeof workspaceSchema>;

export const workspaceMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: z.date(),
});
export type WorkspaceMemberRow = z.input<typeof workspaceMemberSchema>;
export type WorkspaceMember = z.output<typeof workspaceMemberSchema>;
