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
 * Workspace shapes, defined once as zod schemas (the single type source).
 * The schemas are the tRPC .output() egress filter: they strip unknown vendor
 * fields and normalize (e.g. logo → string | null). The *Row types (z.input)
 * annotate what the services return internally — the vendor-API shape, which
 * is deliberately NOT the drizzle row (the vendor parses `metadata` text into
 * an object and declares optionals like `logo?: string | null`, so DB row
 * types don't fit). Wire types are inferred by clients from the router
 * (RouterOutputs), so no z.output aliases are exported.
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

export const workspaceMemberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: z.date(),
});
export type WorkspaceMemberRow = z.input<typeof workspaceMemberSchema>;
