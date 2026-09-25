// Ops domain constants: the stage0 canary and external heartbeat (notification relay
// design §11, ADR 0020, docs/reference/ops-stage0.md).

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

/** The ops domain's job kinds. */
export const OpsJobKinds = {
  /** Sends one stage0 canary (every 5 minutes, only while stage0 is configured). */
  stage0Canary: 'ops.stage0-canary',
} as const;

export const Stage0Policy = {
  /** How often a canary is sent. The external check's grace (15 min) covers two misses. */
  canaryIntervalSeconds: 5 * 60,
  /** How long the canary's POST to the ingest route may take. */
  ingestTimeoutMs: 10 * SECOND,
  /** How long the heartbeat ping may take. */
  heartbeatTimeoutMs: 5 * SECOND,
  /** Canary records are kept this long, then the canary job deletes them. */
  retentionMs: 7 * DAY,
} as const;

/**
 * The synthetic GitHub delivery the canary is. It is a `workflow_run` completed with
 * `success`, which the GitHub adapter maps to `github.workflow_run.succeeded`: a real
 * mapped type, so it takes the whole path to a Discord delivery (a `ping` would be
 * ignored at ingest). The names mark it as a canary to anyone reading the channel or
 * the receipts.
 */
export const Stage0Canary = {
  /** `workflow_run.name`, the event's `workflow` fact. */
  workflow: 'mocco-stage0-canary',
  /** `repository.full_name`, the event's `repo` fact. */
  repo: 'mocco/stage0',
  /** `sender.login`. */
  sender: 'mocco-stage0',
  /** The canary id (`X-GitHub-Delivery`, and `workflow_run.head_branch`) prefix. */
  idPrefix: 'stage0-',
  /** GitHub's `X-GitHub-Event`, `action` and `conclusion` for a successful run. */
  githubEvent: 'workflow_run',
  action: 'completed',
  conclusion: 'success',
  userAgent: 'mocco-stage0',
} as const;

/** What one `sendCanary` did. */
export const CanaryOutcomes = {
  /** Stage0 is not configured (OPS_CANARY_SOURCE_ID or OPS_HEARTBEAT_URL missing). */
  disabled: 'disabled',
  /** The ingest route answered 202. */
  accepted: 'accepted',
  /** Nothing was sent: the source is missing, paused or not GitHub, SERVICE_DOMAIN is
   * missing or the ingest URL would leave it, or the secret does not open. */
  refused: 'refused',
  /** Sent, but the route answered something other than 202, or never answered. */
  failed: 'failed',
} as const;
export type CanaryOutcome = (typeof CanaryOutcomes)[keyof typeof CanaryOutcomes];

/** Why a canary was refused or failed, as recorded on `mocco_ops_canaries.error`. */
export const CanaryReasons = {
  sourceNotFound: 'the canary source does not exist',
  sourceNotGithub: 'the canary source is not a github source',
  sourcePaused: 'the canary source is paused',
  noServiceDomain: 'SERVICE_DOMAIN is not set',
  foreignHost: 'the ingest URL is not on SERVICE_DOMAIN',
  malformedIngestKey: 'the canary source has a malformed ingest key',
  secretUnavailable: 'the canary source secret does not open',
  ingestStatus: (status: number) => `the ingest route answered ${status}`,
  ingestUnreachable: (error: string) => `the ingest route did not answer (${error})`,
} as const;
