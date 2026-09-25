import { z } from 'zod';

/** External services that deliver webhooks to a workspace's inbound source. */
export const InboundKinds = {
  sentry: 'sentry',
  vercel: 'vercel',
  github: 'github',
} as const;
export type InboundKind = (typeof InboundKinds)[keyof typeof InboundKinds];
export const inboundKindSchema = z.enum(Object.values(InboundKinds) as [InboundKind, ...InboundKind[]]);

/**
 * Domain event types produced from inbound webhooks. Keys equal their values
 * (the dotted names are the event catalog's external contract), so call sites
 * read `InboundEventTypes['github.push']`.
 */
export const InboundEventTypes = {
  'sentry.issue.created': 'sentry.issue.created',
  'vercel.deployment.created': 'vercel.deployment.created',
  'vercel.deployment.succeeded': 'vercel.deployment.succeeded',
  'vercel.deployment.error': 'vercel.deployment.error',
  'vercel.deployment.canceled': 'vercel.deployment.canceled',
  'github.push': 'github.push',
  'github.pull_request.opened': 'github.pull_request.opened',
  'github.pull_request.reopened': 'github.pull_request.reopened',
  'github.pull_request.merged': 'github.pull_request.merged',
  'github.pull_request.closed': 'github.pull_request.closed',
  'github.issues.opened': 'github.issues.opened',
  'github.issues.reopened': 'github.issues.reopened',
  'github.issues.closed': 'github.issues.closed',
  'github.release.published': 'github.release.published',
  'github.workflow_run.failed': 'github.workflow_run.failed',
  'github.workflow_run.succeeded': 'github.workflow_run.succeeded',
} as const;
export type InboundEventType = (typeof InboundEventTypes)[keyof typeof InboundEventTypes];
export const inboundEventTypeSchema = z.enum(
  Object.values(InboundEventTypes) as [InboundEventType, ...InboundEventType[]],
);

/**
 * Flat, filterable attributes of an event. Notification rules match them by
 * equality (`{ target: 'production' }`), so values stay scalar.
 */
export const factsSchema = z.record(z.string(), z.union([z.string(), z.boolean()]));
export type Facts = z.infer<typeof factsSchema>;

/** Whether a source accepts deliveries. A paused source answers 404, like an unknown key. */
export const InboundSourceStatuses = {
  active: 'active',
  paused: 'paused',
} as const;
export type InboundSourceStatus = (typeof InboundSourceStatuses)[keyof typeof InboundSourceStatuses];
export const inboundSourceStatusSchema = z.enum(
  Object.values(InboundSourceStatuses) as [InboundSourceStatus, ...InboundSourceStatus[]],
);

/**
 * What became of one received delivery. `pending` is the short window between
 * recording it and publishing its event (a crash there is republished by
 * `inbound.republish-stale`). `over_quota` is stored as-is, so its key matches it.
 */
export const InboundOutcomes = {
  published: 'published',
  ignored: 'ignored',
  over_quota: 'over_quota',
  pending: 'pending',
} as const;
export type InboundOutcome = (typeof InboundOutcomes)[keyof typeof InboundOutcomes];
export const inboundOutcomeSchema = z.enum(Object.values(InboundOutcomes) as [InboundOutcome, ...InboundOutcome[]]);

/** A customer label for a source ("Acme web"). */
export const inboundSourceNameSchema = z.string().trim().min(1).max(100);

/**
 * A signing secret the customer pastes from the vendor (Sentry's Client Secret,
 * Vercel's webhook secret). Whitespace around a copy-paste is dropped.
 */
export const inboundSecretSchema = z.string().trim().min(1).max(1024);

/**
 * Creating a source. Sentry and Vercel need the `secret` the vendor shows; for
 * GitHub, Mocco generates the secret and returns it once, so none is passed.
 */
export const inboundSourceCreateInputSchema = z.object({
  kind: inboundKindSchema,
  name: inboundSourceNameSchema,
  secret: inboundSecretSchema.optional(),
});
export type InboundSourceCreateInput = z.infer<typeof inboundSourceCreateInputSchema>;

/**
 * A source on the wire. The sealed secret never crosses it: `hasSecret` says one
 * is stored. `ingestUrl` is the URL the customer pastes into the vendor.
 */
export const inboundSourceSchema = z.object({
  id: z.uuid(),
  kind: inboundKindSchema,
  name: z.string(),
  status: inboundSourceStatusSchema,
  hasSecret: z.boolean(),
  ingestUrl: z.string(),
  lastReceivedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type InboundSourceDto = z.infer<typeof inboundSourceSchema>;

/**
 * One received delivery on the wire (the activity trace). `seq` is a bigserial, so
 * it stays a digit string end to end, like the audit log's.
 */
export const inboundReceiptSchema = z.object({
  seq: z.string(),
  id: z.uuid(),
  sourceId: z.uuid(),
  externalId: z.string(),
  sourceEvent: z.string().nullable(),
  outcome: inboundOutcomeSchema,
  reason: z.string().nullable(),
  eventType: z.string().nullable(),
  domainEventId: z.uuid().nullable(),
  receivedAt: z.date(),
});
export type InboundReceiptDto = z.infer<typeof inboundReceiptSchema>;

/** Most receipts one page returns. */
export const INBOUND_RECEIPTS_PAGE_MAX = 100;

/** The largest Postgres bigint, the ceiling of a `seq` cursor. */
const MAX_BIGINT = 9_223_372_036_854_775_807n;

/**
 * A `seq` cursor: 1 to 19 digits, within the Postgres bigint range. Anything else
 * fails the parse (BAD_REQUEST at the router), so it never reaches `BigInt()` or SQL.
 */
const SEQ_CURSOR = /^\d{1,19}$/u;

// One refinement, not `.regex().refine()`: zod runs every check even after one fails,
// and BigInt() throws on a string the regex rejected.
export const inboundSeqCursorSchema = z
  .string()
  .refine(value => SEQ_CURSOR.test(value) && BigInt(value) <= MAX_BIGINT, {
    message: 'cursor must be 1 to 19 digits within the bigint range',
  });

/** A page of receipts, newest first. `beforeSeq` is the previous page's `nextCursor`. */
export const inboundReceiptsQuerySchema = z.object({
  sourceId: z.uuid().optional(),
  outcome: inboundOutcomeSchema.optional(),
  beforeSeq: inboundSeqCursorSchema.optional(),
  limit: z.int().min(1).max(INBOUND_RECEIPTS_PAGE_MAX).default(50),
});
export type InboundReceiptsQuery = z.output<typeof inboundReceiptsQuerySchema>;

export const inboundReceiptsPageSchema = z.object({
  receipts: z.array(inboundReceiptSchema),
  /** The `beforeSeq` of the next page, or null on the last page. */
  nextCursor: z.string().nullable(),
});
