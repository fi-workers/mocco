import { z } from 'zod';

/**
 * The domain event catalog (platform foundations §15, ADR 0018). A domain event is
 * a fact one domain publishes for others to react to (notifications, feedback, status,
 * outbound webhooks). It is not the audit log (compliance proof, kept forever) nor a
 * run event (one run's timeline): events are pruned after 30 days.
 *
 * Every type has exactly one zod payload schema here; `EventBus.publish` parses the
 * payload with it, so a subscriber can trust the shape it is handed.
 *
 * The catalog is built from per-area parts. A new area (the inbound sources of #249,
 * products later) adds its own `*EventTypes` + `*EventPayloadSchemas` pair and spreads
 * both into `DomainEventTypes` and `domainEventPayloadSchemas` below.
 */

/** Governance event types, published by RunService and GateService. */
export const GovernanceEventTypes = {
  runSucceeded: 'run.succeeded',
  runFailed: 'run.failed',
  gatePending: 'gate.pending',
  gateResumed: 'gate.resumed',
  gateRejected: 'gate.rejected',
} as const;

/**
 * What every governance event carries about its run, so a notification template can
 * render without another query: the repo and pipeline by name, the commit, and the
 * path of the run page in the app (joined with the app origin by the renderer).
 * `facts` repeats the filterable subset (`repo`, `pipeline`, and `gate` for gates).
 */
const runSubjectShape = {
  workspaceId: z.uuid(),
  runId: z.uuid(),
  /** `owner/name`. */
  repoFullName: z.string().min(1),
  /** `.mocco.yml` `pipeline`. */
  pipelineName: z.string().min(1),
  commitSha: z.string().min(1),
  /** App-relative path of the run page, e.g. `/workspaces/<id>/runs/<id>`. */
  linkPath: z.string().startsWith('/'),
};

export const runEventPayloadSchema = z.object({
  ...runSubjectShape,
  facts: z.object({ repo: z.string(), pipeline: z.string() }),
});

const gateShape = {
  ...runSubjectShape,
  gateName: z.string().min(1),
  /** The gate's position in the pipeline (the run cursor while it waits). */
  gateItemIndex: z.int().nonnegative(),
  facts: z.object({ repo: z.string(), pipeline: z.string(), gate: z.string() }),
};

export const gatePendingPayloadSchema = z.object(gateShape);

export const gateResumedPayloadSchema = z.object({
  ...gateShape,
  /** The voter whose vote satisfied the gate. */
  actorUserId: z.uuid(),
  /** Every resume vote that counted, with the role it counted under. */
  resumedBy: z.array(z.object({ userId: z.uuid(), role: z.string() })),
});

export const gateRejectedPayloadSchema = z.object({
  ...gateShape,
  /** The voter whose reject halted the run. */
  actorUserId: z.uuid(),
  reason: z.string().nullable(),
});

export const governanceEventPayloadSchemas = {
  [GovernanceEventTypes.runSucceeded]: runEventPayloadSchema,
  [GovernanceEventTypes.runFailed]: runEventPayloadSchema,
  [GovernanceEventTypes.gatePending]: gatePendingPayloadSchema,
  [GovernanceEventTypes.gateResumed]: gateResumedPayloadSchema,
  [GovernanceEventTypes.gateRejected]: gateRejectedPayloadSchema,
} as const;

/** Every domain event type. Extension point: spread each area's types here. */
export const DomainEventTypes = {
  ...GovernanceEventTypes,
} as const;
export type DomainEventType = (typeof DomainEventTypes)[keyof typeof DomainEventTypes];

/** The payload schema of every type. Extension point: spread each area's schemas here. */
export const domainEventPayloadSchemas = {
  ...governanceEventPayloadSchemas,
} as const satisfies Record<DomainEventType, z.ZodType>;

export type DomainEventPayload<T extends DomainEventType> = z.output<(typeof domainEventPayloadSchemas)[T]>;

/** Is `type` in the catalog? (Parses stored or external strings at the boundary.) */
export function isDomainEventType(type: string): type is DomainEventType {
  return Object.hasOwn(domainEventPayloadSchemas, type);
}

/**
 * What a subscriber registers for: one exact type, or every type under a dotted
 * prefix (`gate.*` matches `gate.pending`; `github.pull_request.*` matches
 * `github.pull_request.opened`).
 */
export type DomainEventPattern = DomainEventType | `${string}.*`;

const WILDCARD_SUFFIX = '.*';

/** Does `type` match `pattern` (exact, or `prefix.*` for any type under `prefix.`)? */
export function isEventPatternMatch(pattern: string, eventType: string): boolean {
  // sonarjs/null-dereference is a false positive here: both parameters are required strings.
  // eslint-disable-next-line sonarjs/null-dereference
  const prefix = pattern.endsWith(WILDCARD_SUFFIX) ? pattern.slice(0, -1) : undefined;
  // eslint-disable-next-line sonarjs/null-dereference
  return prefix === undefined ? eventType === pattern : eventType.startsWith(prefix);
}

/** The catalog types a pattern resolves to (what a subscriber's handler can receive). */
export type MatchedEventType<P extends DomainEventPattern> = P extends `${infer Prefix}.*`
  ? Extract<DomainEventType, `${Prefix}.${string}`>
  : Extract<P, DomainEventType>;
