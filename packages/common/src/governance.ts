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

// ─────────────────────────────────────────────────────────────
// Gates & resumes (slice 5, PR3). A v2 pipeline gate materializes a `run_gate`
// (state + a snapshot of its requirements) when a run is triggered; a paused run's
// gate collects `resumes` (one vote per person) until the pure evaluator resolves
// it. These are the wire shapes the gate card renders. See the slice-5 gates spec.
// ─────────────────────────────────────────────────────────────

/** A gate's lifecycle: `pending` (collecting votes) → `resumed` | `rejected` |
 * `expired`. Terminal outcomes are declared (ADR 0010); `expired` is reserved for
 * the deferred expiry feature. */
export const GateStates = {
  pending: 'pending',
  resumed: 'resumed',
  rejected: 'rejected',
  expired: 'expired',
} as const;
export type GateState = (typeof GateStates)[keyof typeof GateStates];
export const gateStateSchema = z.enum(Object.values(GateStates) as [GateState, ...GateState[]]);

/** A single vote's decision on a gate. */
export const ResumeDecisions = {
  resume: 'resume',
  reject: 'reject',
} as const;
export type ResumeDecision = (typeof ResumeDecisions)[keyof typeof ResumeDecisions];
export const resumeDecisionSchema = z.enum(Object.values(ResumeDecisions) as [ResumeDecision, ...ResumeDecision[]]);

/** The requirements snapshotted onto a `run_gate` at trigger — the gate item's
 * `resume` N-of-M list plus its policy flags, pinned so a later config/role change
 * can't retroactively alter an in-flight gate (booleans normalized to explicit). */
export const gateRequirementsSchema = z.object({
  resume: z.array(z.object({ role: z.string(), count: z.number().int().positive() })).min(1),
  prevent_self: z.boolean(),
  reason_required: z.boolean(),
});
export type GateRequirements = z.infer<typeof gateRequirementsSchema>;

/** A materialized gate on a run — its position (`itemIndex` in the pipeline), name,
 * live state, and requirements snapshot. `workspaceId` is egress-stripped like
 * `runStepSchema` (the run already carries it). */
export const runGateSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  itemIndex: z.number().int(),
  name: z.string(),
  state: gateStateSchema,
  requirements: gateRequirementsSchema,
  resolvedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type RunGateDto = z.infer<typeof runGateSchema>;

/** A single recorded vote on a gate — one row per (gate, user) by DB constraint.
 * `roleId`/`roleName` are the required role the vote counted under (nullable: a
 * snapshot role later deleted resolves to null). `roleName` is joined for the card's
 * per-role progress (the requirements snapshot is by name). */
export const resumeSchema = z.object({
  id: z.uuid(),
  runGateId: z.uuid(),
  runId: z.uuid(),
  userId: z.uuid(),
  roleId: z.uuid().nullable(),
  roleName: z.string().nullable(),
  decision: resumeDecisionSchema,
  reason: z.string().nullable(),
  createdAt: z.date(),
});
export type ResumeDto = z.infer<typeof resumeSchema>;

/** Resume-a-gate input (the run + workspace scope live on the run router's shared
 * input). `reason` is required by policy only when the gate sets `reason_required`
 * — enforced in the service, not here, so the error is a domain error. */
export const gateResumeInputSchema = z.object({
  gateItemIndex: z.number().int().nonnegative(),
  decision: resumeDecisionSchema,
  reason: z.string().min(1).optional(),
});
export type GateResumeInput = z.infer<typeof gateResumeInputSchema>;

// ─────────────────────────────────────────────────────────────
// Approvals outside runs (#114). Any domain can ask "may this pinned change
// happen?" under the same `GateRequirements` a run gate uses — OTA promotion,
// version-policy changes, flag changesets. A `pre_approval` request must be
// approved before its change is applied; a `review` request records the post-hoc
// review of a change that was applied at once (a rollback, a pause — the
// direction rules in the OTA release control design).
// ─────────────────────────────────────────────────────────────

/** Whether a request gates a change (`pre_approval`) or reviews one already applied (`review`). */
export const ApprovalKinds = {
  preApproval: 'pre_approval',
  review: 'review',
} as const;
export type ApprovalKind = (typeof ApprovalKinds)[keyof typeof ApprovalKinds];
export const approvalKindSchema = z.enum(Object.values(ApprovalKinds) as [ApprovalKind, ...ApprovalKind[]]);

/** A request's lifecycle: `pending` → `approved` | `rejected` | `expired` | `superseded`. */
export const ApprovalStates = {
  pending: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  expired: 'expired',
  superseded: 'superseded',
} as const;
export type ApprovalState = (typeof ApprovalStates)[keyof typeof ApprovalStates];
export const approvalStateSchema = z.enum(Object.values(ApprovalStates) as [ApprovalState, ...ApprovalState[]]);

/** A single vote on an approval request. */
export const ApprovalDecisions = {
  approve: 'approve',
  reject: 'reject',
} as const;
export type ApprovalDecision = (typeof ApprovalDecisions)[keyof typeof ApprovalDecisions];
export const approvalDecisionSchema = z.enum(
  Object.values(ApprovalDecisions) as [ApprovalDecision, ...ApprovalDecision[]],
);

/** An approval request — the pinned change (`action`) and the requirements snapshot. Wire shape. */
export const approvalRequestSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  kind: approvalKindSchema,
  subjectType: z.string(),
  subjectId: z.string(),
  action: z.record(z.string(), z.unknown()),
  requirements: gateRequirementsSchema,
  requestedByUserId: z.uuid().nullable(),
  state: approvalStateSchema,
  expiresAt: z.date().nullable(),
  resolvedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ApprovalRequestDto = z.infer<typeof approvalRequestSchema>;

/** A vote on an approval request — one per (request, user) by DB constraint. */
export const approvalVoteSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  userId: z.uuid(),
  roleId: z.uuid().nullable(),
  decision: approvalDecisionSchema,
  reason: z.string().nullable(),
  createdAt: z.date(),
});
export type ApprovalVoteDto = z.infer<typeof approvalVoteSchema>;

/** Vote input. `reason` is required only when the requirements set `reason_required`
 * — enforced in the service so the error is a domain error. */
export const approvalVoteInputSchema = z.object({
  decision: approvalDecisionSchema,
  reason: z.string().min(1).optional(),
});
export type ApprovalVoteInput = z.infer<typeof approvalVoteInputSchema>;
