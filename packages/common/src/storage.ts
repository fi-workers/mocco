import { z } from 'zod';

/**
 * Object storage (platform foundations §10). One ledger row per stored object; the bytes
 * live in the configured store (S3-compatible or the local filesystem). Wire shapes and
 * constants shared by the backend and, later, product UIs.
 */

/** Who may read an object: `public` objects have a stable URL (a CDN in front of the
 * bucket); `private` ones are reachable only through an expiring signed URL. */
export const Visibilities = {
  public: 'public',
  private: 'private',
} as const;
export type Visibility = (typeof Visibilities)[keyof typeof Visibilities];
export const visibilitySchema = z.enum([Visibilities.public, Visibilities.private]);

/** An object's lifecycle: `pending` (upload URL issued) → `ready` (bytes verified) →
 * `deleted` (bytes removed by the gc job). */
export const ObjectStatuses = {
  pending: 'pending',
  ready: 'ready',
  deleted: 'deleted',
} as const;
export type ObjectStatus = (typeof ObjectStatuses)[keyof typeof ObjectStatuses];

/** A stored object — wire shape. */
export const storedObjectSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  projectId: z.uuid().nullable(),
  product: z.string(),
  key: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  visibility: visibilitySchema,
  status: z.enum([ObjectStatuses.pending, ObjectStatuses.ready, ObjectStatuses.deleted]),
  createdAt: z.date(),
});
export type StoredObjectDto = z.infer<typeof storedObjectSchema>;
