import { RunStates, RunStepStatuses, TriggerSources } from '@mocco/common/execution';
import { GateStates } from '@mocco/common/governance';
import { InboundKinds, InboundOutcomes, InboundSourceStatuses } from '@mocco/common/inbound';
import { JobStatuses } from '@mocco/common/jobs';
import { ChannelKinds, ChannelStatuses, DeliveryStatuses } from '@mocco/common/notification';
import { AppPlatforms, Products } from '@mocco/common/project';
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  bigserial,
  integer,
  jsonb,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
  primaryKey,
} from 'drizzle-orm/pg-core';

import type { AuditAction } from '@mocco/common/audit';
import type { RunState, RunStepStatus } from '@mocco/common/execution';
import type { GateRequirements, GateState, ResumeDecision } from '@mocco/common/governance';
import type { InboundKind, InboundOutcome, InboundSourceStatus } from '@mocco/common/inbound';
import type { Provider } from '@mocco/common/integration';
import type { JobStatus } from '@mocco/common/jobs';
import type {
  ChannelKind,
  ChannelStatus,
  DeliveryStatus,
  DiscordChannelConfig,
  NeutralMessage,
  RuleFilter,
} from '@mocco/common/notification';
import type { AppPlatform, Product } from '@mocco/common/project';

// Table prefix: mocco_. Better Auth tables must also use the mocco_ prefix.
// id: uuid (non-sequential — safe for token/audit/URL exposure).

// Shared column helpers
const createdAt = timestamp('created_at').notNull().defaultNow();
const updatedAt = timestamp('updated_at')
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());

// ─────────────────────────────────────────────────────────────
// Auth tables (email+password today; social providers later). uuid PK — with betterAuth advanced.database.generateId=false,
// ids are generated in the DB (defaultRandom). drizzle keys are camelCase (adapter mapping); columns are snake_case.
// ─────────────────────────────────────────────────────────────

/** Logged-in user. */
export const users = pgTable('mocco_users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text(),
  email: text().notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text(),
  createdAt,
  updatedAt,
});

// ─────────────────────────────────────────────────────────────
// Workspace = the auth vendor's organization plugin, mapped onto product-termed
// tables (mocco_workspaces / mocco_members). drizzle KEYS must match the plugin's
// field names (organizationId etc.); table & column NAMES are ours. Cross-checked
// against the vendor CLI's generated schema. Invitations land with the invite flow.
// ─────────────────────────────────────────────────────────────

/** Workspace (vendor model: organization). */
export const workspaces = pgTable('mocco_workspaces', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  // The vendor requires a non-empty slug, but Mocco has no product use for one:
  // WorkspaceService fills it with a system uuid. It is addressed by nothing —
  // no uniqueness constraint, since a v4 uuid never collides.
  slug: text().notNull(),
  logo: text(),
  metadata: text(),
  createdAt,
});

/** Workspace invitation (vendor model: invitation).
 * The table exists because the plugin's core read path (get-full-organization)
 * hard-joins this model — without it the primary workspace load 500s.
 * The invite FLOW (email delivery, status enum, pending-dedupe, inviter-deletion
 * policy) is deferred; see docs/reference/workspace.md. */
export const invitations = pgTable(
  'mocco_invitations',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text().notNull(),
    role: text(),
    status: text().notNull().default('pending'),
    expiresAt: timestamp('expires_at').notNull(),
    // Policy TBD with the invite flow: cascade means pending invites vanish
    // with the inviter; revisit (nullable + SET NULL) when the flow lands.
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt,
  },
  table => [
    index('mocco_invitations_workspace_id_idx').on(table.organizationId),
    // The plugin queries invitations by email (listUserInvitations).
    index('mocco_invitations_email_idx').on(table.email),
  ],
);

/** Workspace membership (vendor model: member). One row per (workspace, user). */
export const members = pgTable(
  'mocco_members',
  {
    id: uuid().primaryKey().defaultRandom(),
    organizationId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text().notNull().default('member'),
    createdAt,
  },
  table => [
    // Also serves workspace-scoped lookups (composite prefix), so no extra
    // standalone workspace_id index is needed.
    uniqueIndex('mocco_members_workspace_user_uq').on(table.organizationId, table.userId),
    index('mocco_members_user_id_idx').on(table.userId),
    // MVP role set. The vendor may store comma-joined role subsets (e.g. 'owner,admin')
    // via updateMemberRole — allowed; values outside the set are still rejected.
    check('mocco_members_role_check', sql`${table.role} ~ '^(owner|admin|member)(,(owner|admin|member))*$'`),
  ],
);

/** Session. */
export const sessions = pgTable(
  'mocco_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    token: text().notNull().unique(),
    expiresAt: timestamp('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // organization plugin field (drizzle key fixed by the vendor); column speaks product terms.
    // FK self-heals: deleting a workspace clears every session pointing at it.
    activeOrganizationId: uuid('active_workspace_id').references(() => workspaces.id, {
      onDelete: 'set null',
    }),
    createdAt,
    updatedAt,
  },
  table => [
    index('mocco_sessions_user_id_idx').on(table.userId),
    index('mocco_sessions_active_workspace_id_idx').on(table.activeOrganizationId),
  ],
);

/** SSO account (per-provider tokens). */
export const accounts = pgTable(
  'mocco_accounts',
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text(),
    password: text(),
    createdAt,
    updatedAt,
  },
  table => [uniqueIndex('mocco_accounts_provider_account_idx').on(table.providerId, table.accountId)],
);

/** Verification token (email/OTP etc.). */
export const verifications = pgTable('mocco_verifications', {
  id: uuid().primaryKey().defaultRandom(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt,
  updatedAt,
});

// ─────────────────────────────────────────────────────────────
// Integration (slice 3a) — a workspace connects a provider account (GitHub App
// installation), registers repos under it, and watches a branch. Neutral columns
// (external_*_id, provider discriminator stored-not-dispatched); provider-specific
// handshake state lives in the mocco_github_ table. See ADR 0011 + the slice-3 spec.
// ─────────────────────────────────────────────────────────────

/** A workspace's connection to a provider account (github: external_account_id = installation_id). */
export const providerConnections = pgTable(
  'mocco_provider_connections',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    provider: text().$type<Provider>().notNull(),
    externalAccountId: text('external_account_id').notNull(),
    accountLogin: text('account_login').notNull(),
    status: text().notNull().default('active'),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_provider_connections_provider_account_uq').on(t.provider, t.externalAccountId),
    // A UNIQUE CONSTRAINT (not just an index) so mocco_repos' composite FK can reference (id, workspace_id).
    unique('mocco_provider_connections_id_workspace_uq').on(t.id, t.workspaceId),
    check('mocco_provider_connections_provider_check', sql`${t.provider} IN ('github')`),
    check('mocco_provider_connections_status_check', sql`${t.status} IN ('active','suspended','deleted')`),
  ],
);

/** A repository registered under a connection. Identity = external_repo_id; owner/name display-only. */
export const repos = pgTable(
  'mocco_repos',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => providerConnections.id, { onDelete: 'cascade' }),
    externalRepoId: text('external_repo_id').notNull(),
    owner: text().notNull(),
    name: text().notNull(),
    defaultBranch: text('default_branch').notNull(),
    watchedBranch: text('watched_branch'),
    status: text().notNull().default('active'),
    connectedAt: timestamp('connected_at').notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at'),
  },
  t => [
    uniqueIndex('mocco_repos_connection_repo_uq').on(t.connectionId, t.externalRepoId),
    // Composite FK guards the denormalized workspace_id against drift (kept for hot workspace-scoped listing).
    foreignKey({
      columns: [t.connectionId, t.workspaceId],
      foreignColumns: [providerConnections.id, providerConnections.workspaceId],
      name: 'mocco_repos_connection_workspace_fk',
    }),
    check('mocco_repos_status_check', sql`${t.status} IN ('active','inactive')`),
    // A UNIQUE CONSTRAINT so mocco_project_repos' composite FK can reference (id, workspace_id).
    unique('mocco_repos_id_workspace_uq').on(t.id, t.workspaceId),
  ],
);

/** Provider-specific install handshake state — single-use, TTL'd, consumed on the setup callback. */
export const githubConnectStates = pgTable(
  'mocco_github_connect_states',
  {
    state: text().primaryKey(),
    userId: uuid('user_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    githubUserLogin: text('github_user_login'),
    githubUserId: text('github_user_id'),
    createdAt,
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
  },
  t => [index('mocco_github_connect_states_workspace_idx').on(t.workspaceId)],
);

// ─────────────────────────────────────────────────────────────
// Commit sync (slice 3b) — commits observed for a watched repo, and the
// provider webhook deliveries that drive that sync (dedupe by delivery id).
// ─────────────────────────────────────────────────────────────

/** A commit synced for a repo. seq is a per-table monotonic ordinal for cursoring; upserted on (repo_id, sha). */
export const commits = pgTable(
  'mocco_commits',
  {
    id: uuid().primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    seq: bigserial({ mode: 'bigint' }).notNull(),
    sha: text().notNull(),
    branch: text().notNull(),
    message: text().notNull(),
    authorName: text('author_name').notNull(),
    authorEmail: text('author_email').notNull(),
    committedAt: timestamp('committed_at').notNull(),
    syncedAt: timestamp('synced_at').notNull().defaultNow(),
  },
  t => [
    uniqueIndex('mocco_commits_repo_sha_uq').on(t.repoId, t.sha),
    index('mocco_commits_repo_seq_idx').on(t.repoId, t.seq.desc()),
  ],
);

/** A received provider webhook delivery — recorded to dedupe redeliveries by delivery_id. */
export const webhookDeliveries = pgTable(
  'mocco_webhook_deliveries',
  {
    id: uuid().primaryKey().defaultRandom(),
    provider: text().notNull(),
    deliveryId: text('delivery_id').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
  },
  t => [
    uniqueIndex('mocco_webhook_deliveries_delivery_uq').on(t.deliveryId),
    check('mocco_webhook_deliveries_provider_check', sql`${t.provider} IN ('github')`),
  ],
);

// ─────────────────────────────────────────────────────────────
// Config snapshot (slice 3c) — each commit's `.mocco.yml`, fetched and parsed
// at that commit's SHA in the same deferred pass as the commit sync above.
// ─────────────────────────────────────────────────────────────

/** A commit's `.mocco.yml` config, synced 1:1 per commit. Path is always `.mocco.yml` (no per-commit path/hash). */
export const commitConfigs = pgTable(
  'mocco_commit_configs',
  {
    id: uuid().primaryKey().defaultRandom(),
    commitId: uuid('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    present: boolean().notNull().default(true), // false = snapshot confirmed no `.mocco.yml` at this commit
    rawYaml: text('raw_yaml').notNull(),
    parsedJson: jsonb('parsed_json'), // parsed MoccoConfig when valid, else null
    valid: boolean().notNull(),
    validationErrors: jsonb('validation_errors')
      .notNull()
      .default(sql`'[]'::jsonb`),
    syncedAt: timestamp('synced_at').notNull().defaultNow(),
  },
  t => [uniqueIndex('mocco_commit_configs_commit_uq').on(t.commitId)],
);

// ─────────────────────────────────────────────────────────────
// Execution (slice 4) — a commit candidate becomes a Run pinned to that commit's
// config snapshot, executed step-by-step through a neutral trigger → callback →
// advance loop. run_steps are materialized from the pinned definition; run_events
// is the append-only progression log that drives the live timeline (and is the
// audit source in the audit slice). All three carry workspace_id for direct
// tenant scoping. See docs/superpowers/specs/2026-07-26-slice4-runs-execution-design.md.
// ─────────────────────────────────────────────────────────────

/** A run of a commit candidate, pinned to the commit and its config snapshot. */
export const runs = pgTable(
  'mocco_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // The candidate commit this run executes.
    commitId: uuid('commit_id')
      .notNull()
      .references(() => commits.id, { onDelete: 'cascade' }),
    // RESTRICT: the run pins this exact parsed definition — never orphan it.
    commitConfigId: uuid('commit_config_id')
      .notNull()
      .references(() => commitConfigs.id, { onDelete: 'restrict' }),
    // `.$type` aligns the text column with the RunState union (SSOT in @mocco/common),
    // mirroring `provider: text().$type<Provider>()` — the `.output` enum needs it.
    // `awaiting_gate` (paused at a gate) and `rejected` (a gate reject halted it)
    // land with the gates slice.
    state: text().$type<RunState>().notNull().default(RunStates.queued),
    // Cursor into the pinned definition's items; advances on a step succeeding or a
    // gate resolving. Points at a gate item while the run is `awaiting_gate`.
    currentIndex: integer('current_index').notNull().default(0),
    // sha-256 of the opaque per-run callback token; the plaintext is returned once and never stored.
    callbackTokenHash: text('callback_token_hash').notNull(),
    // SET NULL: a run outlives the user who triggered it.
    triggeredByUserId: uuid('triggered_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    triggerSource: text('trigger_source').notNull().default(TriggerSources.manual),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt,
    updatedAt,
  },
  t => [
    index('mocco_runs_workspace_state_idx').on(t.workspaceId, t.state),
    index('mocco_runs_commit_idx').on(t.commitId),
    uniqueIndex('mocco_runs_callback_token_hash_uq').on(t.callbackTokenHash),
    check(
      'mocco_runs_state_check',
      sql`${t.state} IN ('queued','running','succeeded','failed','canceled','awaiting_gate','rejected')`,
    ),
  ],
);

/** A materialized step of a run — one row per step in the pinned definition. `handle`
 * is an opaque adapter handle (keeps adapter words out of the core). */
export const runSteps = pgTable(
  'mocco_run_steps',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    name: text().notNull(),
    executor: text().notNull(),
    // Adapter-specific options, free-form by contract (ADR 0004); absent in the config → null.
    // `.$type` aligns the jsonb column with the wire `with` shape (Record | null via nullable).
    with: jsonb().$type<Record<string, unknown>>(),
    status: text().$type<RunStepStatus>().notNull().default(RunStepStatuses.pending),
    handle: text(),
    logsUrl: text('logs_url'),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_run_steps_run_step_uq').on(t.runId, t.stepIndex),
    check(
      'mocco_run_steps_status_check',
      sql`${t.status} IN ('pending','dispatched','running','succeeded','failed','skipped','canceled')`,
    ),
  ],
);

/** Append-only run progression log. `seq` is a global bigserial cursor — simple and
 * sufficient for the `sinceSeq` live poll (per-run ordinality isn't needed). */
export const runEvents = pgTable(
  'mocco_run_events',
  {
    seq: bigserial({ mode: 'bigint' }).primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    payload: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt,
  },
  t => [index('mocco_run_events_run_seq_idx').on(t.runId, t.seq)],
);

// ─────────────────────────────────────────────────────────────
// Governance — access (slice 5, PR1). A workspace defines named roles and assigns
// its users to them; a role membership is the (role, user) join. This is the
// authorization surface gates resume against (a gate requires N members of a role).
// Both tables carry workspace_id for direct tenant scoping. Gates/resumes land in
// later PRs of this slice. See docs/superpowers/specs/2026-07-27-slice5-gates-approval-design.md.
// ─────────────────────────────────────────────────────────────

/** A named role within a workspace (e.g. "deployer", "sre"). Unique by name per workspace. */
export const roles = pgTable(
  'mocco_roles',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    createdAt,
  },
  t => [
    // Serves workspace-scoped listing (composite prefix), so no standalone workspace_id index is needed.
    uniqueIndex('mocco_roles_workspace_name_uq').on(t.workspaceId, t.name),
  ],
);

/** A user's membership in a role. One row per (role, user). */
export const roleMemberships = pgTable(
  'mocco_role_memberships',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt,
  },
  t => [
    // Serves role-scoped listing (composite prefix) and enforces one membership per person per role.
    uniqueIndex('mocco_role_memberships_role_user_uq').on(t.roleId, t.userId),
    index('mocco_role_memberships_user_id_idx').on(t.userId),
  ],
);

// ─────────────────────────────────────────────────────────────
// Governance — gates & resumes (slice 5, PR3). A v2 pipeline gate materializes a
// `run_gate` per gate item when a run is triggered (its requirements snapshotted so
// a later config/role change can't alter an in-flight gate). A paused run's gate
// collects `resumes` — one vote per person — which the pure evaluator resolves into
// resumed/rejected. Both carry workspace_id for direct tenant scoping. See
// docs/superpowers/specs/2026-07-27-slice5-gates-approval-design.md.
// ─────────────────────────────────────────────────────────────

/** A materialized gate on a run — one row per gate item in the pinned v2 pipeline,
 * keyed by its `item_index` (the item's position, shared namespace with run_steps). */
export const runGates = pgTable(
  'mocco_run_gates',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    // Position of the gate item in the pipeline (mixed with steps); the run cursor
    // points here while `awaiting_gate`.
    itemIndex: integer('item_index').notNull(),
    name: text().notNull(),
    // `.$type` aligns the text column with the GateState union (SSOT in @mocco/common).
    state: text().$type<GateState>().notNull().default(GateStates.pending),
    // The gate item's `resume`/`prevent_self`/`reason_required`, pinned at trigger.
    requirements: jsonb().$type<GateRequirements>().notNull(),
    resolvedAt: timestamp('resolved_at'),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_run_gates_run_item_uq').on(t.runId, t.itemIndex),
    check('mocco_run_gates_state_check', sql`${t.state} IN ('pending','resumed','rejected','expired')`),
  ],
);

/** A single recorded vote on a gate. `user_id` is RESTRICT — a vote's principal is
 * never erased. `role_id` is nullable (SET NULL): the role a vote counted under may
 * later be deleted without corrupting the record. One vote per (gate, user). */
export const resumes = pgTable(
  'mocco_resumes',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runGateId: uuid('run_gate_id')
      .notNull()
      .references(() => runGates.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    // `.$type` aligns the text column with the ResumeDecision union (SSOT in @mocco/common).
    decision: text().$type<ResumeDecision>().notNull(),
    reason: text(),
    createdAt,
  },
  t => [
    // Enforces one vote per person per gate (and serves gate-scoped listing).
    uniqueIndex('mocco_resumes_gate_user_uq').on(t.runGateId, t.userId),
    index('mocco_resumes_run_id_idx').on(t.runId),
    check('mocco_resumes_decision_check', sql`${t.decision} IN ('resume','reject')`),
  ],
);

// ─────────────────────────────────────────────────────────────
// Credential broker (slice 7, PR1) — the workspace allowlist that makes `.mocco.yml`
// a request, not a grant. A row authorizes: "for this repo+pipeline, a step gated
// behind `gate_name` may receive `role` from `provider` for up to `max_ttl_seconds`."
// The broker (PR2) matches a step's pinned `credential` request against these rows;
// no matching row → DENY (fail-closed). Carries workspace_id for direct tenant
// scoping. See docs/superpowers/specs/2026-07-29-slice7-credential-broker-design.md.
// ─────────────────────────────────────────────────────────────

/** A workspace's credential allowlist entry — the authority a step's `credential`
 * request is matched against. Unique per (workspace, repo, pipeline, gate, provider, role). */
export const credentialGrants = pgTable(
  'mocco_credential_grants',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    pipeline: text().notNull(),
    gateName: text('gate_name').notNull(),
    // Cloud provider identifier (e.g. 'aws') — free-form, distinct from the git
    // `Provider` union; the broker's provider port interprets it, not the core.
    provider: text().notNull(),
    role: text().notNull(),
    maxTtlSeconds: integer('max_ttl_seconds').notNull(),
    createdAt,
  },
  t => [
    // The allowlist tuple is unique (and serves workspace-scoped listing via its prefix).
    uniqueIndex('mocco_credential_grants_uq').on(t.workspaceId, t.repoId, t.pipeline, t.gateName, t.provider, t.role),
  ],
);

// ─────────────────────────────────────────────────────────────
// Audit log (slice 8, PR1) — an append-only, per-workspace hash chain. Every
// governance decision (gate resume/reject, credential issue/deny, run trigger)
// appends an entry whose `hash = sha-256(prev_hash ?? '' || canonical(semantic
// fields))`; anyone can re-walk the chain and prove it hasn't been altered or
// back-dated (a system property, always on — ADR 0010). `seq` bigserial is the
// monotonic chain order; `id` is a stable non-sequential handle for the UI/URL. The
// hash covers the CONTENT (workspace/actor/action/subject/payload + prev_hash), NOT
// the DB-assigned `seq`/`created_at`/`id`, so the chain is verifiable from content
// alone. See docs/superpowers/specs/2026-07-29-slice8-audit-log-design.md.
// ─────────────────────────────────────────────────────────────

/** An append-only audit entry — one per governed decision, chained per workspace. */
export const auditLog = pgTable(
  'mocco_audit_log',
  {
    // Monotonic chain order (a gap on `verify` proves a removal). PK.
    seq: bigserial({ mode: 'bigint' }).primaryKey(),
    // Non-sequential stable handle — safe for UI/URL exposure (never the chain key).
    id: uuid().notNull().defaultRandom().unique(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // SET NULL: an actor may be deleted; the entry (and its hash) outlives them.
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    // `.$type` aligns the text column with the AuditAction union (SSOT in @mocco/common).
    action: text().$type<AuditAction>().notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    // `.$type` aligns the jsonb column with the canonicalized payload shape; always an object.
    payload: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Null = the workspace's first entry (no predecessor to bind to).
    prevHash: text('prev_hash'),
    hash: text().notNull(),
    createdAt,
  },
  t => [index('mocco_audit_log_workspace_seq_idx').on(t.workspaceId, t.seq)],
);

// ─────────────────────────────────────────────────────────────
// Projects & product enablement (ADR 0013). A workspace stays the team/billing
// boundary; a project is "a product the team ships" and scopes every product line
// after deploy governance. A project has apps (one per build target) and links to
// repos. Governance data (runs, gates, audit) stays workspace-scoped and relates to
// projects only through mocco_project_repos, so the governance domain is unchanged.
// See docs/reference/project.md.
// ─────────────────────────────────────────────────────────────

/** SQL `IN (...)` list from a constants object — keeps DB checks tied to the SSOT in
 * @mocco/common instead of a hand-copied string list. Values are our own constants. */
const sqlInList = (values: readonly string[]) => sql.raw(values.map(value => `'${value}'`).join(','));

/** A product the team ships (e.g. "Acme mobile"), scoped to a workspace. */
export const projects = pgTable(
  'mocco_projects',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    // url-safe, unique per workspace; later the default public-site host label.
    handle: text().notNull(),
    defaultLocale: text('default_locale').notNull().default('en'),
    createdAt,
    updatedAt,
    // Archived projects keep their data but are hidden from default listings.
    archivedAt: timestamp('archived_at'),
  },
  t => [
    // Serves workspace-scoped listing (composite prefix), so no standalone workspace_id index is needed.
    uniqueIndex('mocco_projects_workspace_handle_uq').on(t.workspaceId, t.handle),
    // A UNIQUE CONSTRAINT so child tables' composite FKs can reference (id, workspace_id).
    unique('mocco_projects_id_workspace_uq').on(t.id, t.workspaceId),
    check('mocco_projects_handle_check', sql`${t.handle} ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'`),
  ],
);

/** A build target of a project (iOS app, Android app, web app, …). */
export const projectApps = pgTable(
  'mocco_project_apps',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    platform: text().$type<AppPlatform>().notNull(),
    name: text().notNull(),
    // iOS bundle id / Android application id.
    bundleId: text('bundle_id'),
    // App Store numeric id / Play package — used by reviews and deep links later.
    storeAppId: text('store_app_id'),
    // Origin allowlist for publishable keys and embedded widgets later.
    webOrigins: text('web_origins').array(),
    createdAt,
    updatedAt,
  },
  t => [
    index('mocco_project_apps_project_idx').on(t.projectId),
    // One app per bundle id per platform within a project.
    uniqueIndex('mocco_project_apps_project_platform_bundle_uq')
      .on(t.projectId, t.platform, t.bundleId)
      .where(sql`${t.bundleId} IS NOT NULL`),
    // Composite FK guards the denormalized workspace_id against drift.
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_project_apps_project_workspace_fk',
    }).onDelete('cascade'),
    check('mocco_project_apps_platform_check', sql`${t.platform} IN (${sqlInList(Object.values(AppPlatforms))})`),
  ],
);

/** A repo linked to a project. A repo may belong to several projects (a monorepo). */
export const projectRepos = pgTable(
  'mocco_project_repos',
  {
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    repoId: uuid('repo_id').notNull(),
    createdAt,
  },
  t => [
    primaryKey({ columns: [t.projectId, t.repoId], name: 'mocco_project_repos_pk' }),
    // Serves the run → project lookup (a run knows its repo).
    index('mocco_project_repos_repo_idx').on(t.repoId),
    // Both composite FKs pin project and repo to the SAME workspace — a project can
    // never link a foreign workspace's repo, even through a direct insert.
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_project_repos_project_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.repoId, t.workspaceId],
      foreignColumns: [repos.id, repos.workspaceId],
      name: 'mocco_project_repos_repo_workspace_fk',
    }).onDelete('cascade'),
  ],
);

/** A product a workspace has turned on. `governance` is implicit and never stored. */
export const workspaceProducts = pgTable(
  'mocco_workspace_products',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    product: text().$type<Product>().notNull(),
    enabledAt: timestamp('enabled_at').notNull().defaultNow(),
    // SET NULL: the enablement outlives the user who turned it on.
    enabledByUserId: uuid('enabled_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  t => [
    primaryKey({ columns: [t.workspaceId, t.product], name: 'mocco_workspace_products_pk' }),
    check(
      'mocco_workspace_products_product_check',
      sql`${t.product} IN (${sqlInList(Object.values(Products).filter(product => product !== Products.governance))})`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────
// Background jobs and schedules (ADR 0014). A job is one small, idempotent unit of
// work; `JobRunner.tick` (driven by Vercel Cron, a self-host cron or curl) claims due
// rows with FOR UPDATE SKIP LOCKED. A schedule enqueues a job per slot, deduped by
// `<scheduleId>:<slot>`. See docs/reference/jobs.md.
// ─────────────────────────────────────────────────────────────

/** One unit of background work. */
export const jobs = pgTable(
  'mocco_jobs',
  {
    id: uuid().primaryKey().defaultRandom(),
    // The handler key (`jobs.prune`, `notification.deliver`, …).
    kind: text().notNull(),
    // Null for platform jobs; set for tenant work so a deleted workspace takes its jobs along.
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    payload: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: text().$type<JobStatus>().notNull().default(JobStatuses.queued),
    runAt: timestamp('run_at').notNull().defaultNow(),
    // Incremented at claim, so a crashed run counts as an attempt.
    attempts: integer().notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    // Consecutive RetryAt reschedules; reset by any other outcome. Caps a handler that
    // keeps asking to be retried later (see domain/jobs/policy.ts).
    deferrals: integer().notNull().default(0),
    lockedUntil: timestamp('locked_until'),
    // The claim token of the runner holding the row; every post-claim write checks it.
    lockedBy: text('locked_by'),
    dedupeKey: text('dedupe_key'),
    lastError: text('last_error'),
    createdAt,
    finishedAt: timestamp('finished_at'),
  },
  t => [
    // The claim path: due queued jobs in run_at order.
    index('mocco_jobs_status_run_at_idx')
      .on(t.status, t.runAt)
      .where(sql`${t.status} = 'queued'`),
    // Workspace-scoped reads and the FK cascade on workspace delete.
    index('mocco_jobs_workspace_idx').on(t.workspaceId),
    // The reclaim path: running jobs whose lock expired.
    index('mocco_jobs_locked_until_idx')
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'running'`),
    // At most one live job per (kind, dedupe_key); finished jobs don't block a new one.
    uniqueIndex('mocco_jobs_kind_dedupe_key_uq')
      .on(t.kind, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('queued','running')`),
    check('mocco_jobs_status_check', sql`${t.status} IN (${sqlInList(Object.values(JobStatuses))})`),
    check('mocco_jobs_attempts_check', sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1 AND ${t.deferrals} >= 0`),
  ],
);

/** A recurring job: every `interval_seconds` (cron expressions are reserved, not yet evaluated). */
export const jobSchedules = pgTable(
  'mocco_job_schedules',
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(),
    // Null for platform (system) schedules.
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    payload: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    cron: text(),
    intervalSeconds: integer('interval_seconds'),
    nextRunAt: timestamp('next_run_at').notNull(),
    enabled: boolean().notNull().default(true),
    lastEnqueuedAt: timestamp('last_enqueued_at'),
    createdAt,
    updatedAt,
  },
  t => [
    // Workspace-scoped reads and the FK cascade on workspace delete.
    index('mocco_job_schedules_workspace_idx').on(t.workspaceId),
    // The tick's due-schedule scan.
    index('mocco_job_schedules_next_run_at_idx')
      .on(t.nextRunAt)
      .where(sql`${t.enabled}`),
    // One system schedule per kind, so the runner can ensure them with ON CONFLICT DO NOTHING.
    uniqueIndex('mocco_job_schedules_system_kind_uq')
      .on(t.kind)
      .where(sql`${t.workspaceId} IS NULL`),
    // A project schedule is pinned to its workspace (skipped by Postgres while project_id is null).
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_job_schedules_project_workspace_fk',
    }).onDelete('cascade'),
    check('mocco_job_schedules_project_check', sql`${t.projectId} IS NULL OR ${t.workspaceId} IS NOT NULL`),
    // Exactly one of cron / interval_seconds.
    check('mocco_job_schedules_timing_check', sql`(${t.cron} IS NULL) <> (${t.intervalSeconds} IS NULL)`),
    check('mocco_job_schedules_interval_check', sql`${t.intervalSeconds} IS NULL OR ${t.intervalSeconds} > 0`),
  ],
);

// ─────────────────────────────────────────────────────────────
// Domain events (platform foundations §15, ADR 0018). A fact one domain publishes for
// others to react to; `EventBus.publish` inserts the row and enqueues one
// `events.deliver` job per subscriber. Pruned after 30 days — the audit log, not this
// table, is the compliance record. See docs/reference/events.md.
// ─────────────────────────────────────────────────────────────

/** A published domain event. */
export const domainEvents = pgTable(
  'mocco_domain_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Insert order across the table, for ordering and debugging. Assigned at insert, not
    // at commit, so a concurrent publish can become visible with a lower seq than one
    // already read: not a gap-free cursor for reconcilers.
    seq: bigserial({ mode: 'bigint' }).notNull().unique('mocco_domain_events_seq_uq'),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    // A catalog type from @mocco/common/events (`gate.pending`, …).
    type: text().notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    payload: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Set by publishers that may publish the same fact twice (e.g. a redelivered inbound
    // webhook): a second publish with the key returns the first event.
    dedupeKey: text('dedupe_key'),
    occurredAt: timestamp('occurred_at').notNull(),
    createdAt,
  },
  t => [
    index('mocco_domain_events_workspace_occurred_at_idx').on(t.workspaceId, t.occurredAt),
    index('mocco_domain_events_type_occurred_at_idx').on(t.type, t.occurredAt),
    // The prune path (retention counts from occurred_at).
    index('mocco_domain_events_occurred_at_idx').on(t.occurredAt),
    uniqueIndex('mocco_domain_events_workspace_dedupe_key_uq')
      .on(t.workspaceId, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    // A project event is pinned to its workspace (skipped by Postgres while project_id is null).
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_domain_events_project_workspace_fk',
    }).onDelete('cascade'),
  ],
);

/** One subscriber has handled one event. The `events.deliver` handler checks it first,
 * so a delivery job that runs again (a second enqueue, a retry after the subscriber
 * returned) doesn't call the subscriber twice. Deleted with its event. */
export const domainEventDeliveries = pgTable(
  'mocco_domain_event_deliveries',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id, { onDelete: 'cascade' }),
    subscriber: text().notNull(),
    deliveredAt: timestamp('delivered_at').notNull(),
  },
  t => [primaryKey({ columns: [t.eventId, t.subscriber], name: 'mocco_domain_event_deliveries_pk' })],
);

// ─────────────────────────────────────────────────────────────
// Notifications (platform foundations §12 F9, notification relay design §6–§8).
// A channel is a destination (a Discord channel today); rules pick which events
// reach it; a delivery is one event sent (or not) to one channel, driven by the
// `notification.deliver` job. See docs/reference/notifications.md.
// ─────────────────────────────────────────────────────────────

/** A Discord server the Mocco bot was installed into for a workspace (relay design §6). */
export const discordGuilds = pgTable(
  'mocco_discord_guilds',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Discord's guild id, taken from the OAuth token response (never the callback query).
    guildId: text('guild_id').notNull(),
    guildName: text('guild_name').notNull(),
    // SET NULL: the install outlives the user who made it.
    installedByUserId: uuid('installed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    // When this workspace last installed the bot into the guild (refreshed on every
    // install). A bot that joined the guild after it was re-added elsewhere: the row is stale.
    installedAt: timestamp('installed_at').notNull().defaultNow(),
    createdAt,
  },
  t => [
    // Its prefix serves workspace listing.
    uniqueIndex('mocco_discord_guilds_workspace_guild_uq').on(t.workspaceId, t.guildId),
    // A UNIQUE CONSTRAINT so channels' composite FK can reference (id, workspace_id).
    unique('mocco_discord_guilds_id_workspace_uq').on(t.id, t.workspaceId),
  ],
);

/** A destination in a workspace, e.g. one Discord channel the Mocco bot posts to. */
export const notificationChannels = pgTable(
  'mocco_notification_channels',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text().$type<ChannelKind>().notNull(),
    // Customer label shown in the UI.
    name: text().notNull(),
    // Non-secret settings: `{ guildId, channelId, channelName }` for Discord.
    config: jsonb().$type<DiscordChannelConfig>().notNull(),
    // The destination's id at the vendor (the Discord channel id), repeated from
    // `config` as a column so uniqueness is a plain index.
    externalId: text('external_id').notNull(),
    // The Discord install the channel belongs to (mocco_discord_guilds.id); required for
    // Discord channels. Deleting a stale install deletes its channels.
    guildId: uuid('guild_id'),
    // A customer-supplied bot token later ("bring your own bot"); null = the Mocco bot.
    secretSealed: text('secret_sealed'),
    status: text().$type<ChannelStatus>().notNull().default(ChannelStatuses.active),
    // Why the channel was disabled (e.g. Discord 403 Missing Access); null while active.
    disabledReason: text('disabled_reason'),
    createdAt,
    updatedAt,
  },
  t => [
    // One channel per vendor destination per workspace; its prefix serves workspace listing.
    uniqueIndex('mocco_notification_channels_workspace_kind_external_uq').on(t.workspaceId, t.kind, t.externalId),
    // A UNIQUE CONSTRAINT so rules' composite FK can reference (id, workspace_id).
    unique('mocco_notification_channels_id_workspace_uq').on(t.id, t.workspaceId),
    check('mocco_notification_channels_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(ChannelKinds))})`),
    check(
      'mocco_notification_channels_status_check',
      sql`${t.status} IN (${sqlInList(Object.values(ChannelStatuses))})`,
    ),
    check(
      'mocco_notification_channels_guild_check',
      sql`${t.kind} NOT IN (${sqlInList([ChannelKinds.discord])}) OR ${t.guildId} IS NOT NULL`,
    ),
    index('mocco_notification_channels_guild_idx').on(t.guildId),
    // Pins the channel to an install of its own workspace.
    foreignKey({
      columns: [t.guildId, t.workspaceId],
      foreignColumns: [discordGuilds.id, discordGuilds.workspaceId],
      name: 'mocco_notification_channels_guild_workspace_fk',
    }).onDelete('cascade'),
  ],
);

/** Which events a channel receives: an exact type or `prefix.*`, plus a flat equality filter on the facts. */
export const notificationRules = pgTable(
  'mocco_notification_rules',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    // An exact catalog type (`vercel.deployment.error`) or a prefix wildcard (`github.*`).
    eventType: text('event_type').notNull(),
    // Only events from this inbound source (payload.sourceId). No FK yet: the inbound
    // sources table (mocco_inbound_sources) lands with the ingest route slice.
    sourceId: uuid('source_id'),
    filter: jsonb()
      .$type<RuleFilter>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt,
  },
  t => [
    index('mocco_notification_rules_channel_idx').on(t.channelId),
    // The fan-out reads every rule of the event's workspace.
    index('mocco_notification_rules_workspace_idx').on(t.workspaceId),
    // The same rule twice on a channel is one rule, so applying a preset again is a no-op.
    uniqueIndex('mocco_notification_rules_channel_rule_uq').on(
      t.channelId,
      t.eventType,
      sql`coalesce(${t.sourceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.filter,
    ),
    // Pins the rule to its channel's workspace, and deletes it with the channel.
    foreignKey({
      columns: [t.channelId, t.workspaceId],
      foreignColumns: [notificationChannels.id, notificationChannels.workspaceId],
      name: 'mocco_notification_rules_channel_workspace_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * One event sent (or not) to one channel. Created by the fan-out with the rendered
 * message and settled by `notification.deliver`. Deleted with its event when events
 * are pruned (30 days), so the activity trace and its deliveries age out together.
 */
export const notificationDeliveries = pgTable(
  'mocco_notification_deliveries',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // SET NULL: a deleted channel keeps its delivery history; a queued delivery then ends `suppressed`.
    channelId: uuid('channel_id').references(() => notificationChannels.id, { onDelete: 'set null' }),
    eventId: uuid('event_id')
      .notNull()
      .references(() => domainEvents.id, { onDelete: 'cascade' }),
    // The first rule that matched; SET NULL when the rule is removed later.
    ruleId: uuid('rule_id').references(() => notificationRules.id, { onDelete: 'set null' }),
    status: text().$type<DeliveryStatus>().notNull().default(DeliveryStatuses.queued),
    // Send attempts made (calls to the sender), not job claims.
    attempts: integer().notNull().default(0),
    // The last HTTP status the sender reported, when it reported one.
    responseCode: integer('response_code'),
    // The last failure or retry reason (already redacted by the sender).
    error: text(),
    // The vendor's message id once sent (Discord message id).
    externalMessageId: text('external_message_id'),
    // What is (or was) sent, rendered once at fan-out.
    message: jsonb().$type<NeutralMessage>().notNull(),
    // When the delivery job will try again (a rate limit or sender pause); null otherwise.
    nextAttemptAt: timestamp('next_attempt_at'),
    // When a run claimed the delivery (status `sending`); a stale claim may be resent.
    sendingAt: timestamp('sending_at'),
    sentAt: timestamp('sent_at'),
    // A stage0 canary (docs/reference/ops-stage0.md): set at fan-out, so the activity
    // trace can hide or label it and the sender knows to delete the message it posts.
    canary: boolean().notNull().default(false),
    createdAt,
    updatedAt,
  },
  t => [
    // One delivery per event per channel: a redelivered event fans out to nothing new.
    uniqueIndex('mocco_notification_deliveries_event_channel_uq').on(t.eventId, t.channelId),
    // Recent deliveries of a workspace (activity).
    index('mocco_notification_deliveries_workspace_created_at_idx').on(t.workspaceId, t.createdAt.desc()),
    // Per-workspace fairness: sends in the last minute.
    index('mocco_notification_deliveries_workspace_sent_at_idx')
      .on(t.workspaceId, t.sentAt)
      .where(sql`${t.sentAt} IS NOT NULL`),
    index('mocco_notification_deliveries_channel_idx').on(t.channelId),
    // The FK's SET NULL on rule delete.
    index('mocco_notification_deliveries_rule_idx')
      .on(t.ruleId)
      .where(sql`${t.ruleId} IS NOT NULL`),
    // The reconcile's scan of unsettled deliveries.
    index('mocco_notification_deliveries_unsettled_idx')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('queued','sending')`),
    check(
      'mocco_notification_deliveries_status_check',
      sql`${t.status} IN (${sqlInList(Object.values(DeliveryStatuses))})`,
    ),
    check('mocco_notification_deliveries_attempts_check', sql`${t.attempts} >= 0`),
  ],
);

/**
 * Discord pacing shared by every runner: a bucket (`channel:<discord channel id>` or
 * `global`) is blocked until `blocked_until`. Platform-scoped (the bot is shared).
 */
export const discordRateLimits = pgTable('mocco_discord_rate_limits', {
  bucket: text().primaryKey(),
  blockedUntil: timestamp('blocked_until').notNull(),
});

/** Discord bot install handshake state — single-use, TTL'd, bound to the user and workspace
 * (same shape as mocco_github_connect_states). */
export const discordConnectStates = pgTable(
  'mocco_discord_connect_states',
  {
    state: text().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdAt,
    expiresAt: timestamp('expires_at').notNull(),
    consumedAt: timestamp('consumed_at'),
  },
  t => [index('mocco_discord_connect_states_workspace_idx').on(t.workspaceId)],
);

// ─────────────────────────────────────────────────────────────
// Inbound webhook sources (notification relay design §5, ADR 0019). A source is one
// vendor account a workspace connected: its unguessable ingest key is the URL path
// segment, and its signing secret is sealed (SecretBox, AAD
// 'mocco_inbound_sources:<id>'). Every delivery leaves a receipt, deduped by the
// vendor's delivery id: the "why didn't it arrive?" trace, and the republish source
// after a crash between recording and publishing. Receipts are pruned after 30 days.
// See docs/reference/inbound.md.
// ─────────────────────────────────────────────────────────────

/** A connected webhook source (Sentry, Vercel or GitHub) of a workspace. */
export const inboundSources = pgTable(
  'mocco_inbound_sources',
  {
    // SourceService generates the id (randomUUID) so the AAD is known when sealing.
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text().$type<InboundKind>().notNull(),
    name: text().notNull(),
    // 32 random bytes, base64url. An identifier, not a credential: every request must
    // also carry a valid signature.
    ingestKey: text('ingest_key').notNull(),
    secretSealed: text('secret_sealed').notNull(),
    status: text().$type<InboundSourceStatus>().notNull().default(InboundSourceStatuses.active),
    lastReceivedAt: timestamp('last_received_at'),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_inbound_sources_ingest_key_uq').on(t.ingestKey),
    index('mocco_inbound_sources_workspace_idx').on(t.workspaceId),
    // Target of the receipts' composite FK, which pins a receipt to its source's workspace.
    unique('mocco_inbound_sources_id_workspace_uq').on(t.id, t.workspaceId),
    check('mocco_inbound_sources_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(InboundKinds))})`),
    check(
      'mocco_inbound_sources_status_check',
      sql`${t.status} IN (${sqlInList(Object.values(InboundSourceStatuses))})`,
    ),
  ],
);

/** One delivery a source received, and what became of it. */
export const inboundReceipts = pgTable(
  'mocco_inbound_receipts',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Insert order: the trace's cursor (newest first).
    seq: bigserial({ mode: 'bigint' }).notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').notNull(),
    // The vendor's delivery id (Request-ID, payload id, X-GitHub-Delivery): the dedupe key.
    externalId: text('external_id').notNull(),
    // The vendor's name for the delivery (`issue.created`, `push`), when it has one.
    sourceEvent: text('source_event'),
    outcome: text().$type<InboundOutcome>().notNull(),
    // Why it produced no event (ignored) or was dropped (over_quota).
    reason: text(),
    eventType: text('event_type'),
    domainEventId: uuid('domain_event_id').references(() => domainEvents.id, { onDelete: 'set null' }),
    // The event payload ({ sourceId, facts, message }), kept so a stuck pending
    // receipt can be republished.
    normalized: jsonb(),
    // Failed publishes of a pending receipt. The republish scan takes the fewest first,
    // and gives up (ignored) after INBOUND_MAX_PUBLISH_ATTEMPTS.
    publishAttempts: integer('publish_attempts').notNull().default(0),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
  },
  t => [
    uniqueIndex('mocco_inbound_receipts_source_external_id_uq').on(t.sourceId, t.externalId),
    // The trace: a workspace's receipts, newest first.
    index('mocco_inbound_receipts_workspace_seq_idx').on(t.workspaceId, t.seq.desc()),
    // The trace filtered by source.
    index('mocco_inbound_receipts_source_seq_idx').on(t.sourceId, t.seq.desc()),
    // The daily quota and the hard ceiling: a workspace's receipts in the last 24 hours.
    index('mocco_inbound_receipts_workspace_received_at_idx').on(t.workspaceId, t.receivedAt),
    // inbound.republish-stale: pending receipts, fewest failed publishes first, then oldest.
    index('mocco_inbound_receipts_pending_idx')
      .on(t.publishAttempts, t.receivedAt)
      .where(sql`${t.outcome} = 'pending'`),
    // inbound.prune (retention counts from received_at).
    index('mocco_inbound_receipts_received_at_idx').on(t.receivedAt),
    // The SET NULL lookup when a domain event is pruned.
    index('mocco_inbound_receipts_domain_event_idx').on(t.domainEventId),
    foreignKey({
      columns: [t.sourceId, t.workspaceId],
      foreignColumns: [inboundSources.id, inboundSources.workspaceId],
      name: 'mocco_inbound_receipts_source_workspace_fk',
    }).onDelete('cascade'),
    check('mocco_inbound_receipts_outcome_check', sql`${t.outcome} IN (${sqlInList(Object.values(InboundOutcomes))})`),
    check('mocco_inbound_receipts_publish_attempts_check', sql`${t.publishAttempts} >= 0`),
  ],
);

// ─────────────────────────────────────────────────────────────
// Ops: the stage0 canary (notification relay design §11, ADR 0020). Each run of the
// `ops.stage0-canary` schedule sends one signed synthetic webhook to the canary source
// over HTTP and records it here; the canary's Discord delivery marks it delivered and
// the external heartbeat ping is recorded with it. Platform-scoped (no workspace), and
// pruned after 7 days by the canary job. See docs/reference/ops-stage0.md.
// ─────────────────────────────────────────────────────────────

/** One stage0 canary: what the ingest route answered, and whether it reached Discord. */
export const opsCanaries = pgTable(
  'mocco_ops_canaries',
  {
    id: uuid().primaryKey().defaultRandom(),
    // `stage0-<ISO minute>`: the delivery id the canary is sent with (X-GitHub-Delivery).
    canaryId: text('canary_id').notNull(),
    // The canary source (no FK: the record outlives a deleted source).
    sourceId: uuid('source_id').notNull(),
    sentAt: timestamp('sent_at').notNull(),
    // The ingest route's HTTP status; null when no request was made or it never answered.
    ingestStatus: integer('ingest_status'),
    // Why the canary failed before or at ingest (configuration, network, a non-202).
    error: text(),
    // When its Discord delivery was sent.
    deliveredAt: timestamp('delivered_at'),
    // When the heartbeat was pinged, and what it answered (null: no answer).
    heartbeatAt: timestamp('heartbeat_at'),
    heartbeatStatus: integer('heartbeat_status'),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_ops_canaries_canary_id_uq').on(t.canaryId),
    // The prune.
    index('mocco_ops_canaries_sent_at_idx').on(t.sentAt),
  ],
);
