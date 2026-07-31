import { z } from 'zod';

/**
 * Audit-log shapes (slice 8, PR1). The audit is an append-only, per-workspace hash
 * chain — a system property, always on (ADR 0010), not a `.mocco.yml` toggle. Every
 * governance decision appends an entry whose `hash = sha-256(prev_hash ?? '' ||
 * canonical(semantic fields))`; any observer can re-walk the chain and prove it
 * hasn't been altered. Defined once as zod schemas (the single type source) and used
 * as the tRPC `.output()` egress filter (the read surface lands in PR2).
 */

/** The governance actions an audit entry records — the SSOT for `action` (no magic
 * strings). Values are dotted `domain.event` strings, an extensible set: a new
 * governed event adds a key here. `gate.*` from GateService, `credential.*` from the
 * broker, `run.triggered` from RunService — all wired in PR2. */
export const AuditActions = {
  gateResumed: 'gate.resumed',
  gateRejected: 'gate.rejected',
  credentialIssued: 'credential.issued',
  credentialDenied: 'credential.denied',
  runTriggered: 'run.triggered',
} as const;
export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];
export const auditActionSchema = z.enum(Object.values(AuditActions) as [AuditAction, ...AuditAction[]]);

/**
 * A single audit-log entry — the wire shape the read surface (PR2) renders. `seq` is
 * a DB `bigserial` (the monotonic chain order); it exceeds JS's safe-integer range
 * over time, so it stays a string end-to-end (the same treatment as `commitSchema.seq`
 * / `runEventSchema.seq`). `workspaceId` is egress-stripped like `runEventSchema` (the
 * read is already workspace-scoped). `prevHash` is null for a workspace's first entry.
 */
export const auditEntrySchema = z.object({
  seq: z.string(),
  id: z.uuid(),
  actorUserId: z.uuid().nullable(),
  action: auditActionSchema,
  subjectType: z.string(),
  subjectId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  prevHash: z.string().nullable(),
  hash: z.string(),
  createdAt: z.date(),
});
export type AuditEntryDto = z.infer<typeof auditEntrySchema>;

/**
 * The result of re-walking a workspace's chain. `intact` true means every entry's
 * stored hash equals the recomputation from the running `prev`; false carries the
 * `brokenAtSeq` (a digit-string, like `seq`) of the first entry whose hash or
 * `prev_hash` linkage doesn't reconcile — the proof-of-tamper coordinate.
 */
export const chainVerificationSchema = z.object({
  intact: z.boolean(),
  brokenAtSeq: z.string().optional(),
});
export type ChainVerification = z.infer<typeof chainVerificationSchema>;
