import { ApiKeyKinds } from '@mocco/common/apikey';
import { RunStates, RunStepStatuses, TriggerSources } from '@mocco/common/execution';
import {
  ChangesetSources,
  ChangesetStates,
  FlagFileSyncStates,
  FlagLifecycles,
  FlagManagers,
  FlagTypes,
  StaleKinds,
} from '@mocco/common/flags';
import { ApprovalDecisions, ApprovalKinds, ApprovalStates, GateStates } from '@mocco/common/governance';
import { ArticleStatuses, RevisionKinds, TranslationStates } from '@mocco/common/help';
import { InboundKinds, InboundOutcomes, InboundSourceStatuses } from '@mocco/common/inbound';
import { JobStatuses } from '@mocco/common/jobs';
import { AuthorKinds, ConversationStatuses, MessageVisibilities } from '@mocco/common/messenger';
import { ChannelKinds, ChannelStatuses, DeliveryStatuses } from '@mocco/common/notification';
import { OtaTools, PolicyDirections } from '@mocco/common/ota';
import {
  CertificateStatuses,
  OtaClientEventTypes,
  OtaDeploymentKinds,
  OtaDirectiveTypes,
  OtaPlatforms,
  OtaProtocols,
  OtaReleaseStatuses,
  OtaUpdateKinds,
} from '@mocco/common/ota-hosting';
import { AppPlatforms, Products } from '@mocco/common/project';
import {
  CheckErrorKinds,
  CheckOutcomes,
  ComponentImpacts,
  ComponentStatuses,
  IncidentPolicies,
  IncidentSeverities,
  IncidentStatuses,
  IncidentVisibilities,
  LocationKinds,
  MaintenanceStatuses,
  MonitorKinds,
  MonitorStates,
  QuorumModes,
  RoundVerdicts,
} from '@mocco/common/status';
import { ObjectStatuses, Visibilities } from '@mocco/common/storage';
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  bigserial,
  bigint,
  smallint,
  integer,
  date,
  jsonb,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
  primaryKey,
} from 'drizzle-orm/pg-core';

import type { ApiKeyKind, ApiScope } from '@mocco/common/apikey';
import type { AuditAction } from '@mocco/common/audit';
import type { RunState, RunStepStatus } from '@mocco/common/execution';
import type {
  AttributeClause,
  ChangeDiffEntry,
  ChangeOp,
  ChangesetSource,
  ChangesetState,
  FlagFileSyncState,
  FlagLifecycle,
  FlagManager,
  FlagType,
  RolloutEntry,
  Rule,
  StaleKind,
} from '@mocco/common/flags';
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalState,
  GateRequirements,
  GateState,
  ResumeDecision,
} from '@mocco/common/governance';
import type { ArticleStatus, RevisionKind, TranslationState } from '@mocco/common/help';
import type { InboundKind, InboundOutcome, InboundSourceStatus } from '@mocco/common/inbound';
import type { Provider } from '@mocco/common/integration';
import type { JobStatus } from '@mocco/common/jobs';
import type {
  AuthorKind,
  ConversationStatus,
  MessageVisibility,
  MessengerCategory,
  MessengerContext,
  PushProvider,
} from '@mocco/common/messenger';
import type {
  ChannelKind,
  ChannelStatus,
  DeliveryStatus,
  DiscordChannelConfig,
  NeutralMessage,
  RuleFilter,
} from '@mocco/common/notification';
import type { OtaTool, PolicyDirection, VersionMessage, VersionPolicyRules } from '@mocco/common/ota';
import type {
  CertificateStatus,
  OtaDeploymentKind,
  OtaDirectiveType,
  OtaClientEventType,
  OtaPlatform,
  OtaProtocol,
  OtaReleaseStatus,
  OtaUpdateKind,
} from '@mocco/common/ota-hosting';
import type { AppPlatform, Product } from '@mocco/common/project';
import type {
  CheckErrorKind,
  CheckOutcome,
  ComponentImpact,
  ComponentStatus,
  IncidentPolicy,
  IncidentSeverity,
  IncidentStatus,
  IncidentVisibility,
  LocationKind,
  MaintenanceStatus,
  MonitorKind,
  MonitorSpec,
  MonitorState,
  QuorumMode,
  RoundVerdict,
} from '@mocco/common/status';
import type { ObjectStatus, Visibility } from '@mocco/common/storage';

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
// OAuth 2.1 authorization server (ADR 0025) — the tables Better Auth's MCP plugin owns,
// so an MCP client can sign in as a person and act with that person's roles.
//
// These are vendor-shaped, not ours. Every column below is what `auth generate` emits for
// the plugin set in `domain/auth/provider.ts`; only the table prefix and the uuid primary
// keys are Mocco's, matching the auth tables above. Do not tidy a field away because it
// looks unused — the vendor reads them, and a missing model fails at adapter start with
// "model X was not found in the schema object".
//
// Regenerate rather than hand-edit when the plugin set changes:
//   npx auth@<version> generate --adapter drizzle --dialect postgresql --config <config>
// ─────────────────────────────────────────────────────────────

/** Signing keys for the tokens the authorization server issues; served as the JWKS that
 * `requireMcpAuth` verifies against. */
export const jwks = pgTable('mocco_jwks', {
  id: uuid().primaryKey().defaultRandom(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt,
  expiresAt: timestamp('expires_at'),
  alg: text(),
  crv: text(),
});

/** A registered MCP client. Most columns are its OAuth client metadata, which on the
 * 2026-07-28 revision arrives through CIMD rather than dynamic registration. */
export const oauthClients = pgTable(
  'mocco_oauth_clients',
  {
    id: uuid().primaryKey().defaultRandom(),
    // The OAuth `client_id` — the client's own identifier, not ours, so text.
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: boolean().default(false),
    skipConsent: boolean('skip_consent'),
    enableEndSession: boolean('enable_end_session'),
    subjectType: text('subject_type'),
    scopes: text().array(),
    clientCredentialsScopes: text('client_credentials_scopes')
      .array()
      .default(sql`'{}'::text[]`),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt,
    updatedAt,
    name: text(),
    uri: text(),
    icon: text(),
    contacts: text().array(),
    tos: text(),
    policy: text(),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris').array().notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    // Set at registration so a desktop or CLI client is not refused its loopback redirect.
    applicationType: text('application_type'),
    jwks: text(),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types').array(),
    responseTypes: text('response_types').array(),
    requirePKCE: boolean('require_pkce'),
    dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
    referenceId: text('reference_id'),
    metadata: jsonb(),
  },
  t => [index('mocco_oauth_clients_user_idx').on(t.userId)],
);

/** A protected resource (RFC 8707 / RFC 9728). Ours is the MCP endpoint: tokens are
 * audience-bound to its `identifier`, so one minted for another server cannot be replayed. */
export const oauthResources = pgTable('mocco_oauth_resources', {
  id: uuid().primaryKey().defaultRandom(),
  identifier: text().notNull().unique(),
  name: text().notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes').array(),
  customClaims: jsonb('custom_claims'),
  dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
  disabled: boolean().default(false),
  createdAt,
  updatedAt,
  policyVersion: integer('policy_version').default(1),
  metadata: jsonb(),
});

/** Which clients may ask for which resources. Both sides join on the business key the
 * vendor uses (`client_id`, `identifier`), not on our row ids. */
export const oauthClientResources = pgTable(
  'mocco_oauth_client_resources',
  {
    id: uuid().primaryKey().defaultRandom(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: 'cascade' }),
    metadata: jsonb(),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_oauth_client_resources_client_resource_uq').on(t.clientId, t.resourceId),
    index('mocco_oauth_client_resources_client_idx').on(t.clientId),
    index('mocco_oauth_client_resources_resource_idx').on(t.resourceId),
  ],
);

/** Refresh tokens. `rotation_replay_*` is the overlap window that lets a retried refresh
 * recover the earlier response instead of being treated as a replay. */
export const oauthRefreshTokens = pgTable(
  'mocco_oauth_refresh_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    token: text().notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text().array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt,
    revoked: timestamp(),
    rotatedAt: timestamp('rotated_at'),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: timestamp('rotation_replay_expires_at'),
    authTime: timestamp('auth_time'),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  t => [
    index('mocco_oauth_refresh_tokens_client_idx').on(t.clientId),
    index('mocco_oauth_refresh_tokens_session_idx').on(t.sessionId),
    index('mocco_oauth_refresh_tokens_user_idx').on(t.userId),
    index('mocco_oauth_refresh_tokens_code_idx').on(t.authorizationCodeId),
  ],
);

/** Access tokens. `confirmation` carries the DPoP binding when the client is sender-constrained. */
export const oauthAccessTokens = pgTable(
  'mocco_oauth_access_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    token: text().notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text().array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    refreshId: uuid('refresh_id').references(() => oauthRefreshTokens.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt,
    revoked: timestamp(),
    confirmation: jsonb(),
    scopes: text().array().notNull(),
  },
  t => [
    index('mocco_oauth_access_tokens_client_idx').on(t.clientId),
    index('mocco_oauth_access_tokens_session_idx').on(t.sessionId),
    index('mocco_oauth_access_tokens_user_idx').on(t.userId),
    index('mocco_oauth_access_tokens_code_idx').on(t.authorizationCodeId),
    index('mocco_oauth_access_tokens_refresh_idx').on(t.refreshId),
  ],
);

/** What a person has already agreed a client may do, so they are asked once rather than
 * on every authorization. */
export const oauthConsents = pgTable(
  'mocco_oauth_consents',
  {
    id: uuid().primaryKey().defaultRandom(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    referenceId: text('reference_id'),
    resources: text().array(),
    requestedUserInfoClaims: text('requested_user_info_claims').array(),
    scopes: text().array().notNull(),
    createdAt,
    updatedAt,
  },
  t => [index('mocco_oauth_consents_client_idx').on(t.clientId), index('mocco_oauth_consents_user_idx').on(t.userId)],
);

/** Spent client assertions, kept until they expire so one cannot be replayed. */
export const oauthClientAssertions = pgTable('mocco_oauth_client_assertions', {
  id: uuid().primaryKey().defaultRandom(),
  expiresAt: timestamp('expires_at').notNull(),
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
    // Monotonic chain order. PK. Gaps are normal (a rolled-back insert still uses a
    // value); a removal shows up as a broken `prev_hash` link, not as a gap.
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
    // A UNIQUE CONSTRAINT so per-app tables' composite FKs can reference (id, workspace_id).
    unique('mocco_project_apps_id_workspace_uq').on(t.id, t.workspaceId),
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
// Approvals outside runs (#114). A pinned change any domain asks to make (OTA
// promotion, a version-policy change, a flag changeset) collects votes under the
// same GateRequirements a run gate uses, evaluated by the same pure evaluator.
// `review` requests record the post-hoc review of a change applied at once.
// ─────────────────────────────────────────────────────────────

/** A request to approve (or review) one pinned change. */
export const approvalRequests = pgTable(
  'mocco_approval_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text().$type<ApprovalKind>().notNull(),
    // What the change is about, e.g. ('ota.version_policy', <appId>). Opaque to governance.
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(),
    // The pinned intended (or, for a review, applied) change. Handlers apply exactly this.
    action: jsonb()
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Snapshot at creation — a later policy edit never rewrites a pending request.
    requirements: jsonb().$type<GateRequirements>().notNull(),
    // SET NULL: a request outlives its requester; prevent_self then can't match (fail-closed).
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    // Others who proposed it (a merged commit's pusher and author, #145): prevent_self bars them too.
    coProposerUserIds: uuid('co_proposer_user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    state: text().$type<ApprovalState>().notNull().default(ApprovalStates.pending),
    expiresAt: timestamp('expires_at'),
    resolvedAt: timestamp('resolved_at'),
    createdAt,
  },
  t => [
    index('mocco_approval_requests_workspace_state_idx').on(t.workspaceId, t.state, t.createdAt),
    index('mocco_approval_requests_subject_idx').on(t.workspaceId, t.subjectType, t.subjectId),
    check('mocco_approval_requests_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(ApprovalKinds))})`),
    check('mocco_approval_requests_state_check', sql`${t.state} IN (${sqlInList(Object.values(ApprovalStates))})`),
  ],
);

/** One person's vote on an approval request. */
export const approvalVotes = pgTable(
  'mocco_approval_votes',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    // RESTRICT like mocco_resumes: a vote is evidence and keeps its voter.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // The required role the vote counted under (SET NULL if the role is later deleted).
    roleId: uuid('role_id').references(() => roles.id, { onDelete: 'set null' }),
    decision: text().$type<ApprovalDecision>().notNull(),
    reason: text(),
    createdAt,
  },
  t => [
    // One vote per person per request (and serves request-scoped listing).
    uniqueIndex('mocco_approval_votes_request_user_uq').on(t.requestId, t.userId),
    check(
      'mocco_approval_votes_decision_check',
      sql`${t.decision} IN (${sqlInList(Object.values(ApprovalDecisions))})`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────
// OTA release control — version policy and native force update (phase 2 of
// docs/specs/2026-09-25-ota-release-control-design.md). One policy per store app
// (an iOS or Android project app); every applied change is kept in an append-only
// history with its direction and, for a gated change, the approval that applied it.
// ─────────────────────────────────────────────────────────────

/** A store app's version policy: the floors that trigger hard / soft update prompts. */
export const otaVersionPolicies = pgTable(
  'mocco_ota_version_policies',
  {
    appId: uuid('app_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    minSupportedVersion: text('min_supported_version'),
    recommendedVersion: text('recommended_version'),
    blockedVersions: text('blocked_versions')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    messages: jsonb()
      .$type<Record<string, VersionMessage>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    storeUrl: text('store_url'),
    softPromptIntervalHours: integer('soft_prompt_interval_hours').notNull().default(72),
    // Requirements for tightening changes; null = they apply without approval.
    approvalPolicy: jsonb('approval_policy').$type<GateRequirements>(),
    // Incremented on every applied change; the cache key and the optimistic-concurrency token.
    revision: integer().notNull(),
    createdAt,
    updatedAt,
  },
  t => [
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [projectApps.id, projectApps.workspaceId],
      name: 'mocco_ota_version_policies_app_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_ota_version_policies_project_workspace_fk',
    }).onDelete('cascade'),
    check('mocco_ota_version_policies_interval_check', sql`${t.softPromptIntervalHours} BETWEEN 1 AND 8760`),
    check('mocco_ota_version_policies_revision_check', sql`${t.revision} >= 1`),
  ],
);

/** An applied version-policy change — append-only evidence. */
export const otaVersionPolicyChanges = pgTable(
  'mocco_ota_version_policy_changes',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    before: jsonb().$type<VersionPolicyRules>(),
    after: jsonb().$type<VersionPolicyRules>().notNull(),
    direction: text().$type<PolicyDirection>().notNull(),
    // SET NULL: the change outlives the person who made it.
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    // The approval that applied a gated change (null for ungated / relaxing changes).
    approvalRequestId: uuid('approval_request_id').references(() => approvalRequests.id, { onDelete: 'set null' }),
    reason: text(),
    createdAt,
  },
  t => [
    index('mocco_ota_version_policy_changes_app_idx').on(t.appId, t.createdAt),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [projectApps.id, projectApps.workspaceId],
      name: 'mocco_ota_version_policy_changes_app_workspace_fk',
    }).onDelete('cascade'),
    check(
      'mocco_ota_version_policy_changes_direction_check',
      sql`${t.direction} IN (${sqlInList(Object.values(PolicyDirections))})`,
    ),
  ],
);

// ─────────────────────────────────────────────────────────────
// OTA release control — phase 1: the team's existing OTA tool's publishing token,
// sealed with SecretBox and released by the credential broker only to a step that
// reached a resumed gate. The row id is generated by the service (it is the SecretBox
// AAD), the one exception to DB-generated ids (backend conventions, SecretBox).
// ─────────────────────────────────────────────────────────────

/** A sealed publishing credential for an external OTA tool. */
export const otaExternalCredentials = pgTable(
  'mocco_ota_external_credentials',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    tool: text().$type<OtaTool>().notNull(),
    // Unique per workspace: it is the broker `role` a grant and `.mocco.yml` name.
    name: text().notNull(),
    // SecretBox envelope, AAD 'mocco_ota_external_credentials:<id>'. Never in a DTO.
    secretSealed: text('secret_sealed').notNull(),
    // First 8 hex chars of SHA-256 of the secret — for display only.
    secretFingerprint: text('secret_fingerprint').notNull(),
    // SET NULL: the credential outlives the person who stored it.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    rotatedAt: timestamp('rotated_at'),
  },
  t => [
    uniqueIndex('mocco_ota_external_credentials_workspace_name_uq').on(t.workspaceId, t.name),
    index('mocco_ota_external_credentials_project_idx').on(t.projectId),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_ota_external_credentials_project_workspace_fk',
    }).onDelete('cascade'),
    check('mocco_ota_external_credentials_tool_check', sql`${t.tool} IN (${sqlInList(Object.values(OtaTools))})`),
  ],
);

// ─────────────────────────────────────────────────────────────
// Object storage (platform foundations §10). The ledger of every stored object: the bytes
// live in the configured ObjectStore; this row says who owns them, what they are, and
// whether the upload finished. Uploads are two-phase (pending → ready); the storage.gc
// job removes pending rows older than a day and the bytes of deleted ones.
// ─────────────────────────────────────────────────────────────

export const objects = pgTable(
  'mocco_objects',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    /** The product line that stored it (`Products`), for quotas and per-product policy. */
    product: text().notNull(),
    /** The store key: `<pub|prv>/w/<workspace>/[p/<project>/]<product>/<id>/<filename>`. */
    key: text().notNull(),
    contentType: text('content_type').notNull(),
    /** The declared size while pending; the verified size once ready. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text(),
    visibility: text().$type<Visibility>().notNull(),
    status: text().$type<ObjectStatus>().notNull().default(ObjectStatuses.pending),
    // SET NULL: an object outlives the person who uploaded it.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    readyAt: timestamp('ready_at'),
    deletedAt: timestamp('deleted_at'),
  },
  t => [
    uniqueIndex('mocco_objects_key_uq').on(t.key),
    index('mocco_objects_workspace_product_idx').on(t.workspaceId, t.product),
    // The gc job's scan: stale pending uploads and deleted objects.
    index('mocco_objects_status_created_idx').on(t.status, t.createdAt),
    // A project's object is pinned to its workspace (skipped by Postgres while project_id is null).
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_objects_project_workspace_fk',
    }).onDelete('cascade'),
    check('mocco_objects_visibility_check', sql`${t.visibility} IN (${sqlInList(Object.values(Visibilities))})`),
    check('mocco_objects_status_check', sql`${t.status} IN (${sqlInList(Object.values(ObjectStatuses))})`),
    check('mocco_objects_size_check', sql`${t.sizeBytes} >= 0`),
  ],
);

// ─────────────────────────────────────────────────────────────
// Feature flags (#101, ADRs 0023 and 0024). A flag is defined per project; each
// environment (a flag target: an evaluation scope with no built-in meaning) holds a
// config of it. Configs change only through changesets, and every applied changeset
// bumps the environment's version and writes an immutable ruleset snapshot.
// ─────────────────────────────────────────────────────────────

/** An evaluation scope of a project's flags ("Environment" in the UI, ADR 0023). */
export const flagEnvironments = pgTable(
  'mocco_flag_environments',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    key: text().notNull(),
    name: text().notNull(),
    // Set exactly when the environment is protected: changes then need this gate's approval.
    changeGate: jsonb('change_gate').$type<GateRequirements>(),
    // Roles whose members may kill a flag (ungated); empty: any workspace member.
    killRoles: text('kill_roles')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // The version of the latest applied changeset; 0 until the first one.
    currentVersion: integer('current_version').notNull().default(0),
    // The repo whose pipeline deploys what this environment serves (#146): only for
    // correlation (runs on the timeline). It never grants or bypasses anything.
    linkedRepoId: uuid('linked_repo_id').references(() => repos.id, { onDelete: 'set null' }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_flag_environments_project_key_uq').on(t.projectId, t.key),
    unique('mocco_flag_environments_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_flag_environments_project_fk',
    }).onDelete('cascade'),
    check('mocco_flag_environments_key_check', sql`${t.key} ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'`),
  ],
);

/** A flag's definition: its key, type and variants, shared by every environment. */
export const flags = pgTable(
  'mocco_flags',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    key: text().notNull(),
    type: text().$type<FlagType>().notNull(),
    variants: jsonb().$type<Record<string, unknown>>().notNull(),
    description: text(),
    lifecycle: text().$type<FlagLifecycle>().notNull().default(FlagLifecycles.temporary),
    // Whether publishable keys (browsers, apps) get this flag over OFREP; off by default so
    // internal flags can't be enumerated from a client.
    clientVisible: boolean('client_visible').notNull().default(false),
    // `repo`: defined by `.mocco/flags.yml` (#145) and read-only in the console, except a kill.
    managedBy: text('managed_by').$type<FlagManager>().notNull().default(FlagManagers.ui),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_flags_project_key_uq').on(t.projectId, t.key),
    unique('mocco_flags_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_flags_project_fk',
    }).onDelete('cascade'),
    check('mocco_flags_type_check', sql`${t.type} IN (${sqlInList(Object.values(FlagTypes))})`),
    check('mocco_flags_lifecycle_check', sql`${t.lifecycle} IN (${sqlInList(Object.values(FlagLifecycles))})`),
    check('mocco_flags_managed_by_check', sql`${t.managedBy} IN (${sqlInList(Object.values(FlagManagers))})`),
  ],
);

/** A flag's state in one environment. Written only by an applied changeset. */
export const flagConfigs = pgTable(
  'mocco_flag_configs',
  {
    environmentId: uuid('environment_id').notNull(),
    flagId: uuid('flag_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    enabled: boolean().notNull().default(false),
    killed: boolean().notNull().default(false),
    defaultVariant: text('default_variant').notNull(),
    // What a killed flag serves (ADR 0024).
    offVariant: text('off_variant').notNull(),
    // Ordered targeting rules; the first whose clauses all match serves.
    rules: jsonb().$type<Rule[]>().notNull().default([]),
    // When set, no-rule callers with a targeting key get this percentage rollout.
    rollout: jsonb().$type<RolloutEntry[]>(),
    // Mixed into percentage bucketing (`mocco-v1`); changed only by a changeset.
    salt: text()
      .notNull()
      .default(sql`md5(random()::text || clock_timestamp()::text)`),
    // The environment version that last changed this config.
    version: integer().notNull(),
  },
  t => [
    primaryKey({ columns: [t.environmentId, t.flagId], name: 'mocco_flag_configs_pk' }),
    foreignKey({
      columns: [t.environmentId, t.workspaceId],
      foreignColumns: [flagEnvironments.id, flagEnvironments.workspaceId],
      name: 'mocco_flag_configs_environment_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.flagId, t.workspaceId],
      foreignColumns: [flags.id, flags.workspaceId],
      name: 'mocco_flag_configs_flag_fk',
    }).onDelete('cascade'),
  ],
);

/** A named group of targeting keys and attribute rules in one environment, used by flag
 * rules. Environment-scoped, so editing it is governed by that environment's gate. */
export const flagSegments = pgTable(
  'mocco_flag_segments',
  {
    environmentId: uuid('environment_id').notNull(),
    key: text().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text().notNull(),
    includedKeys: text('included_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    excludedKeys: text('excluded_keys')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // OR of AND groups of attribute clauses.
    rules: jsonb().$type<AttributeClause[][]>().notNull().default([]),
    // The environment version that last changed this segment.
    version: integer().notNull(),
  },
  t => [
    primaryKey({ columns: [t.environmentId, t.key], name: 'mocco_flag_segments_pk' }),
    foreignKey({
      columns: [t.environmentId, t.workspaceId],
      foreignColumns: [flagEnvironments.id, flagEnvironments.workspaceId],
      name: 'mocco_flag_segments_environment_fk',
    }).onDelete('cascade'),
  ],
);

/** A proposed change to one environment: ordered ops against `base_version`. */
export const flagChangesets = pgTable(
  'mocco_flag_changesets',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    environmentId: uuid('environment_id').notNull(),
    state: text().$type<ChangesetState>().notNull(),
    source: text().$type<ChangesetSource>().notNull(),
    ops: jsonb().$type<ChangeOp[]>().notNull(),
    // Rendered before/after per field, computed against the base version.
    diff: jsonb().$type<ChangeDiffEntry[]>().notNull(),
    // sha256 over {environmentId, baseVersion, ops}: what an approval pins.
    contentHash: text('content_hash').notNull(),
    baseVersion: integer('base_version').notNull(),
    appliedVersion: integer('applied_version'),
    proposedByUserId: uuid('proposed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text(),
    // A repo changeset (#145): the repo and the commit of `.mocco/flags.yml` it came from.
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    commitSha: text('commit_sha'),
    // Who else proposed it: the commit's author when someone else pushed (prevent_self bars them too).
    coProposerUserIds: uuid('co_proposer_user_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // A protected environment's changeset: the approval request deciding it, the gate it
    // was proposed under (pinned) and when it stops waiting.
    approvalRequestId: uuid('approval_request_id').references(() => approvalRequests.id, { onDelete: 'set null' }),
    requirements: jsonb().$type<GateRequirements>(),
    expiresAt: timestamp('expires_at'),
    createdAt,
    resolvedAt: timestamp('resolved_at'),
  },
  t => [
    index('mocco_flag_changesets_environment_idx').on(t.environmentId, t.createdAt),
    index('mocco_flag_changesets_pending_idx')
      .on(t.expiresAt)
      .where(sql`${t.state} = 'pending'`),
    uniqueIndex('mocco_flag_changesets_applied_version_uq').on(t.environmentId, t.appliedVersion),
    // A newer push supersedes the older one: at most one pending repo changeset per environment and repo.
    uniqueIndex('mocco_flag_changesets_repo_pending_uq')
      .on(t.environmentId, t.repoId)
      .where(sql`${t.state} = 'pending' AND ${t.repoId} IS NOT NULL`),
    foreignKey({
      columns: [t.environmentId, t.workspaceId],
      foreignColumns: [flagEnvironments.id, flagEnvironments.workspaceId],
      name: 'mocco_flag_changesets_environment_fk',
    }).onDelete('cascade'),
    check('mocco_flag_changesets_state_check', sql`${t.state} IN (${sqlInList(Object.values(ChangesetStates))})`),
    check('mocco_flag_changesets_source_check', sql`${t.source} IN (${sqlInList(Object.values(ChangesetSources))})`),
    check('mocco_flag_changesets_applied_check', sql`(${t.state} = 'applied') = (${t.appliedVersion} IS NOT NULL)`),
  ],
);

/** Which flag keys a commit's code quotes (#146), cached per repo and commit: the
 * deploy-aware warning reads it instead of downloading the archive again. */
export const flagCodeScans = pgTable(
  'mocco_flag_code_scans',
  {
    workspaceId: uuid('workspace_id').notNull(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    // The keys looked for; a key outside it means scanning again.
    scannedKeys: text('scanned_keys').array().notNull(),
    foundKeys: text('found_keys').array().notNull(),
    // False when the archive was too large to read whole: an absent key is then unknown.
    isComplete: boolean('is_complete').notNull(),
    createdAt,
  },
  t => [primaryKey({ columns: [t.repoId, t.commitSha], name: 'mocco_flag_code_scans_pk' })],
);

/** Each sync of a project's `.mocco/flags.yml` from a default-branch commit (#145): how
 * it ended, and why a refused file was refused. */
export const flagFileSyncs = pgTable(
  'mocco_flag_file_syncs',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'set null' }),
    commitSha: text('commit_sha').notNull(),
    state: text().$type<FlagFileSyncState>().notNull(),
    issues: jsonb().$type<{ path: string; message: string; line?: number }[]>().notNull().default([]),
    createdAt,
  },
  t => [
    index('mocco_flag_file_syncs_project_idx').on(t.projectId, t.createdAt),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_flag_file_syncs_project_fk',
    }).onDelete('cascade'),
    check('mocco_flag_file_syncs_state_check', sql`${t.state} IN (${sqlInList(Object.values(FlagFileSyncStates))})`),
  ],
);

/** The compiled flagd document of each environment version. Immutable. */
export const flagRulesetSnapshots = pgTable(
  'mocco_flag_ruleset_snapshots',
  {
    environmentId: uuid('environment_id').notNull(),
    version: integer().notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    // A strong ETag of the serialized document.
    etag: text().notNull(),
    document: jsonb().$type<Record<string, unknown>>().notNull(),
    changesetId: uuid('changeset_id').references(() => flagChangesets.id, { onDelete: 'set null' }),
    createdAt,
  },
  t => [
    primaryKey({ columns: [t.environmentId, t.version], name: 'mocco_flag_ruleset_snapshots_pk' }),
    foreignKey({
      columns: [t.environmentId, t.workspaceId],
      foreignColumns: [flagEnvironments.id, flagEnvironments.workspaceId],
      name: 'mocco_flag_ruleset_snapshots_environment_fk',
    }).onDelete('cascade'),
  ],
);

/** Hourly evaluation counts from SDK telemetry (#144), added to as reports arrive. Old
 * buckets are pruned except each flag's newest, which keeps "last evaluated" forever. */
export const flagEvalRollups = pgTable(
  'mocco_flag_eval_rollups',
  {
    environmentId: uuid('environment_id').notNull(),
    flagKey: text('flag_key').notNull(),
    // '' when no variant was served (a disabled flag, an error).
    variant: text().notNull(),
    bucketHour: timestamp('bucket_hour').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    count: bigint({ mode: 'number' }).notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
  },
  t => [
    primaryKey({
      columns: [t.environmentId, t.flagKey, t.variant, t.bucketHour],
      name: 'mocco_flag_eval_rollups_pk',
    }),
    index('mocco_flag_eval_rollups_bucket_idx').on(t.bucketHour),
    foreignKey({
      columns: [t.environmentId, t.workspaceId],
      foreignColumns: [flagEnvironments.id, flagEnvironments.workspaceId],
      name: 'mocco_flag_eval_rollups_environment_fk',
    }).onDelete('cascade'),
    check('mocco_flag_eval_rollups_count_check', sql`${t.count} > 0`),
  ],
);

/** Flags that look ready for cleanup, rewritten by the daily `flags.stale.detect` job.
 * Advisory: no governance decision reads them. */
export const flagStaleFindings = pgTable(
  'mocco_flag_stale_findings',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    flagId: uuid('flag_id').notNull(),
    kind: text().$type<StaleKind>().notNull(),
    detectedAt: timestamp('detected_at').notNull(),
    lastEvaluatedAt: timestamp('last_evaluated_at'),
    servedVariant: text('served_variant'),
    // Hidden until then; the job keeps it while the finding still holds.
    dismissedUntil: timestamp('dismissed_until'),
    dismissedByUserId: uuid('dismissed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  t => [
    uniqueIndex('mocco_flag_stale_findings_flag_kind_uq').on(t.flagId, t.kind),
    index('mocco_flag_stale_findings_project_idx').on(t.workspaceId, t.projectId),
    foreignKey({
      columns: [t.flagId, t.workspaceId],
      foreignColumns: [flags.id, flags.workspaceId],
      name: 'mocco_flag_stale_findings_flag_fk',
    }).onDelete('cascade'),
    check('mocco_flag_stale_findings_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(StaleKinds))})`),
  ],
);

// ─────────────────────────────────────────────────────────────
// Messenger (#95): conversations between a project's signed-in users ("contacts") and
// its team. One inbox per project: the same user on iOS, Android and web is one contact.
// ─────────────────────────────────────────────────────────────

/** A project's messenger: the identity secret its server signs user ids with, and the
 * categories users pick from. */
export const messengerSettings = pgTable(
  'mocco_messenger_settings',
  {
    projectId: uuid('project_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    // HMAC key for `userHash`; SecretBox-sealed (AAD = project id), never returned.
    identitySecretSealed: text('identity_secret_sealed').notNull(),
    categories: jsonb().$type<MessengerCategory[]>().notNull(),
    // People who aren't signed in may write too, leaving an email to be reached at.
    allowGuests: boolean('allow_guests').notNull().default(false),
    createdAt,
    updatedAt,
  },
  t => [
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_messenger_settings_project_fk',
    }).onDelete('cascade'),
  ],
);

/** A user of the project who has contacted the team, keyed by the app's own user id. */
export const messengerContacts = pgTable(
  'mocco_messenger_contacts',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    // The app's user id; null for a guest (not signed in), who is known by email.
    externalUserId: text('external_user_id'),
    name: text(),
    email: text(),
    // A guest's long-lived device token (hashed), so the same device finds them again.
    guestTokenHash: text('guest_token_hash'),
    traits: jsonb().$type<Record<string, string | number | boolean>>().notNull().default({}),
    lastContext: jsonb('last_context').$type<MessengerContext>().notNull().default({}),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    blockedAt: timestamp('blocked_at'),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_messenger_contacts_project_user_uq').on(t.projectId, t.externalUserId),
    uniqueIndex('mocco_messenger_contacts_guest_token_uq').on(t.guestTokenHash),
    check(
      'mocco_messenger_contacts_identity_check',
      sql`${t.externalUserId} IS NOT NULL OR (${t.email} IS NOT NULL AND ${t.guestTokenHash} IS NOT NULL)`,
    ),
    unique('mocco_messenger_contacts_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_messenger_contacts_project_fk',
    }).onDelete('cascade'),
  ],
);

/** A contact's session on one device: an opaque token, stored hashed. */
export const messengerSessions = pgTable(
  'mocco_messenger_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_messenger_sessions_token_uq').on(t.tokenHash),
    foreignKey({
      columns: [t.contactId, t.workspaceId],
      foreignColumns: [messengerContacts.id, messengerContacts.workspaceId],
      name: 'mocco_messenger_sessions_contact_fk',
    }).onDelete('cascade'),
  ],
);

/** One conversation (a "contact us" request is one). `last_message_seq` allocates each
 * message's number; the contact's and each operator's read position are seqs. */
export const messengerConversations = pgTable(
  'mocco_messenger_conversations',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    status: text().$type<ConversationStatus>().notNull(),
    category: text(),
    lastMessageSeq: integer('last_message_seq').notNull().default(0),
    lastMessageAt: timestamp('last_message_at').notNull(),
    // The newest seq the team wrote publicly; drives the contact's unread state.
    lastOperatorSeq: integer('last_operator_seq').notNull().default(0),
    contactLastReadSeq: integer('contact_last_read_seq').notNull().default(0),
    preview: text().notNull(),
    contextAtOpen: jsonb('context_at_open').$type<MessengerContext>().notNull().default({}),
    closedAt: timestamp('closed_at'),
    createdAt,
  },
  t => [
    unique('mocco_messenger_conversations_id_workspace_uq').on(t.id, t.workspaceId),
    index('mocco_messenger_conversations_inbox_idx').on(t.workspaceId, t.projectId, t.status, t.lastMessageAt),
    index('mocco_messenger_conversations_contact_idx').on(t.contactId, t.lastMessageAt),
    foreignKey({
      columns: [t.contactId, t.workspaceId],
      foreignColumns: [messengerContacts.id, messengerContacts.workspaceId],
      name: 'mocco_messenger_conversations_contact_fk',
    }).onDelete('cascade'),
    check(
      'mocco_messenger_conversations_status_check',
      sql`${t.status} IN (${sqlInList(Object.values(ConversationStatuses))})`,
    ),
  ],
);

/** A message in a conversation, numbered by `seq`. Internal notes are never served to the contact. */
export const messengerMessages = pgTable(
  'mocco_messenger_messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    seq: integer().notNull(),
    authorKind: text('author_kind').$type<AuthorKind>().notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    visibility: text().$type<MessageVisibility>().notNull(),
    body: text().notNull(),
    clientMessageId: text('client_message_id'),
    context: jsonb().$type<MessengerContext>(),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_messenger_messages_conversation_seq_uq').on(t.conversationId, t.seq),
    uniqueIndex('mocco_messenger_messages_conversation_client_uq').on(t.conversationId, t.clientMessageId),
    foreignKey({
      columns: [t.conversationId, t.workspaceId],
      foreignColumns: [messengerConversations.id, messengerConversations.workspaceId],
      name: 'mocco_messenger_messages_conversation_fk',
    }).onDelete('cascade'),
    check('mocco_messenger_messages_author_check', sql`${t.authorKind} IN (${sqlInList(Object.values(AuthorKinds))})`),
    check(
      'mocco_messenger_messages_visibility_check',
      sql`${t.visibility} IN (${sqlInList(Object.values(MessageVisibilities))})`,
    ),
    // Internal notes come from the team only.
    check('mocco_messenger_messages_internal_check', sql`${t.visibility} = 'public' OR ${t.authorKind} = 'operator'`),
  ],
);

/** A screenshot a contact uploaded. It belongs to the contact until a message claims it
 * (`message_id`), so it can go with the message that starts a conversation. The bytes
 * live in object storage (`mocco_objects`). */
export const messengerAttachments = pgTable(
  'mocco_messenger_attachments',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    messageId: uuid('message_id').references(() => messengerMessages.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt,
  },
  t => [
    index('mocco_messenger_attachments_message_idx').on(t.messageId),
    index('mocco_messenger_attachments_contact_idx').on(t.contactId, t.createdAt),
    foreignKey({
      columns: [t.contactId, t.workspaceId],
      foreignColumns: [messengerContacts.id, messengerContacts.workspaceId],
      name: 'mocco_messenger_attachments_contact_fk',
    }).onDelete('cascade'),
  ],
);

/** A contact's device that takes push notifications. A token moves to whoever
 * registered it last in the project (one device, one signed-in user). */
export const messengerPushTokens = pgTable(
  'mocco_messenger_push_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    provider: text().$type<PushProvider>().notNull(),
    token: text().notNull(),
    platform: text().notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
    // Set when the push service says the device is gone; such tokens get nothing.
    disabledAt: timestamp('disabled_at'),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_messenger_push_tokens_project_token_uq').on(t.projectId, t.token),
    index('mocco_messenger_push_tokens_contact_idx').on(t.contactId),
    foreignKey({
      columns: [t.contactId, t.workspaceId],
      foreignColumns: [messengerContacts.id, messengerContacts.workspaceId],
      name: 'mocco_messenger_push_tokens_contact_fk',
    }).onDelete('cascade'),
  ],
);

/** How far each team member has read a conversation. */
export const messengerOperatorReads = pgTable(
  'mocco_messenger_operator_reads',
  {
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    lastReadSeq: integer('last_read_seq').notNull(),
  },
  t => [
    primaryKey({ columns: [t.conversationId, t.userId], name: 'mocco_messenger_operator_reads_pk' }),
    foreignKey({
      columns: [t.conversationId, t.workspaceId],
      foreignColumns: [messengerConversations.id, messengerConversations.workspaceId],
      name: 'mocco_messenger_operator_reads_conversation_fk',
    }).onDelete('cascade'),
  ],
);

// ─────────────────────────────────────────────────────────────
// Public /v1 API (ADR 0017): project-scoped API keys and the rate limiter's counters.
// ─────────────────────────────────────────────────────────────

export const apiKeys = pgTable(
  'mocco_api_keys',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    kind: text().$type<ApiKeyKind>().notNull(),
    name: text().notNull(),
    // SHA-256 (hex) of the full token; the token itself is shown once and never stored.
    tokenHash: text('token_hash').notNull(),
    last4: text().notNull(),
    scopes: text().array().$type<ApiScope[]>().notNull(),
    // The flag environment a flags:read key reads; set exactly when the key holds flags:read.
    flagEnvironmentId: uuid('flag_environment_id'),
    // SET NULL: a key outlives the person who created it.
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    lastUsedAt: timestamp('last_used_at'),
    expiresAt: timestamp('expires_at'),
    revokedAt: timestamp('revoked_at'),
  },
  t => [
    uniqueIndex('mocco_api_keys_token_hash_uq').on(t.tokenHash),
    index('mocco_api_keys_project_idx').on(t.workspaceId, t.projectId),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_api_keys_project_workspace_fk',
    }).onDelete('cascade'),
    check('mocco_api_keys_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(ApiKeyKinds))})`),
    foreignKey({
      columns: [t.flagEnvironmentId, t.workspaceId],
      foreignColumns: [flagEnvironments.id, flagEnvironments.workspaceId],
      name: 'mocco_api_keys_flag_environment_fk',
    }).onDelete('cascade'),
    check(
      'mocco_api_keys_flag_environment_check',
      sql`('flags:read' = ANY(${t.scopes})) = (${t.flagEnvironmentId} IS NOT NULL)`,
    ),
  ],
);

/** Fixed-window counters for the Postgres rate limiter: one row per bucket per window. */
export const rateLimitCounters = pgTable(
  'mocco_rate_limit_counters',
  {
    bucket: text().notNull(),
    windowStart: timestamp('window_start').notNull(),
    count: integer().notNull(),
  },
  t => [
    primaryKey({ columns: [t.bucket, t.windowStart], name: 'mocco_rate_limit_counters_pk' }),
    // The hourly prune scans by window.
    index('mocco_rate_limit_counters_window_idx').on(t.windowStart),
  ],
);

// ─────────────────────────────────────────────────────────────
// Mocco-hosted OTA (phase 3 of the OTA release control design; ADRs 0021, 0022). An OTA
// app is a project's React Native app served over the Expo Updates protocol. Signed
// bytes (manifests, directives) are stored exactly as uploaded and never rewritten.
// ─────────────────────────────────────────────────────────────

export const otaApps = pgTable(
  'mocco_ota_apps',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    // The project's React Native app this OTA app serves (one OTA app per project app).
    projectAppId: uuid('project_app_id').notNull(),
    protocol: text().$type<OtaProtocol>().notNull().default(OtaProtocols.expoUpdates),
    // Fixed at creation: signed manifests carry asset URLs under it.
    assetBaseUrl: text('asset_base_url').notNull(),
    signingRequired: boolean('signing_required').notNull().default(true),
    // Mixed into device id hashes, so the same EAS-Client-ID hashes differently per app
    // and the stored hash can't be matched against other apps or a rainbow table.
    devicePepper: text('device_pepper')
      .notNull()
      .default(sql`md5(random()::text || clock_timestamp()::text)`),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_ota_apps_project_app_uq').on(t.projectAppId),
    unique('mocco_ota_apps_id_workspace_uq').on(t.id, t.workspaceId),
    index('mocco_ota_apps_project_idx').on(t.workspaceId, t.projectId),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_ota_apps_project_workspace_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.projectAppId, t.workspaceId],
      foreignColumns: [projectApps.id, projectApps.workspaceId],
      name: 'mocco_ota_apps_project_app_workspace_fk',
    }).onDelete('cascade'),
    check('mocco_ota_apps_protocol_check', sql`${t.protocol} IN (${sqlInList(Object.values(OtaProtocols))})`),
  ],
);

export const otaSigningCertificates = pgTable(
  'mocco_ota_signing_certificates',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    // The `keyid` the app's codeSigningMetadata names (expo-updates default "root").
    // Several active certificates may share it while old binaries are still in use.
    keyid: text().notNull(),
    certificatePem: text('certificate_pem').notNull(),
    spkiSha256: text('spki_sha256').notNull(),
    subject: text().notNull(),
    notAfter: timestamp('not_after').notNull(),
    status: text().$type<CertificateStatus>().notNull().default(CertificateStatuses.active),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_ota_signing_certificates_app_spki_uq').on(t.appId, t.spkiSha256),
    index('mocco_ota_signing_certificates_app_keyid_idx').on(t.appId, t.keyid),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_signing_certificates_app_fk',
    }).onDelete('cascade'),
    check(
      'mocco_ota_signing_certificates_status_check',
      sql`${t.status} IN (${sqlInList(Object.values(CertificateStatuses))})`,
    ),
  ],
);

export const otaChannels = pgTable(
  'mocco_ota_channels',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    name: text().notNull(),
    isProtected: boolean('is_protected').notNull().default(false),
    // Who must approve promotions — set exactly when the channel is protected.
    policy: jsonb().$type<GateRequirements>(),
    // Optional: devices must send `mocco-channel-key` (pre-release channels).
    accessKeyHash: text('access_key_hash'),
    createdAt,
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [
    uniqueIndex('mocco_ota_channels_app_name_uq').on(t.appId, t.name),
    unique('mocco_ota_channels_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_channels_app_fk',
    }).onDelete('cascade'),
    check('mocco_ota_channels_policy_check', sql`(${t.isProtected}) = (${t.policy} IS NOT NULL)`),
  ],
);

export const otaReleases = pgTable(
  'mocco_ota_releases',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    runtimeVersion: text('runtime_version').notNull(),
    message: text(),
    gitSha: text('git_sha'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    // The machine principal that uploaded it, e.g. `github:repo:123:ref:refs/heads/main`.
    uploadedByPrincipal: text('uploaded_by_principal'),
    status: text().$type<OtaReleaseStatus>().notNull().default(OtaReleaseStatuses.uploading),
    isMandatory: boolean('is_mandatory').notNull().default(false),
    createdAt,
  },
  t => [
    unique('mocco_ota_releases_id_workspace_uq').on(t.id, t.workspaceId),
    index('mocco_ota_releases_app_runtime_idx').on(t.appId, t.runtimeVersion, t.createdAt),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_releases_app_fk',
    }).onDelete('cascade'),
    check('mocco_ota_releases_status_check', sql`${t.status} IN (${sqlInList(Object.values(OtaReleaseStatuses))})`),
  ],
);

export const otaUpdates = pgTable(
  'mocco_ota_updates',
  {
    // The Expo update id, generated in CI: it is inside the signed manifest, so it is
    // not DB-generated (the one exception to DB-generated ids in OTA).
    id: uuid().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    releaseId: uuid('release_id').notNull(),
    platform: text().$type<OtaPlatform>().notNull(),
    runtimeVersion: text('runtime_version').notNull(),
    kind: text().$type<OtaUpdateKind>().notNull(),
    // Self for originals; for a republish, the original whose assets it reuses.
    contentOfUpdateId: uuid('content_of_update_id').notNull(),
    // For a republish: the update it is valid to roll back from.
    supersedesUpdateId: uuid('supersedes_update_id'),
    // The manifest `createdAt` — devices load only strictly newer ones (ADR 0021).
    commitTime: timestamp('commit_time', { withTimezone: true }).notNull(),
    // The exact signed bytes, served byte for byte.
    manifestBody: text('manifest_body').notNull(),
    signature: text(),
    keyid: text(),
    // The certificate the signature verified against (which runtimes depend on which key).
    certificateId: uuid('certificate_id').references(() => otaSigningCertificates.id, { onDelete: 'set null' }),
    launchAssetHash: text('launch_asset_hash').notNull(),
    totalBytes: bigint('total_bytes', { mode: 'number' }).notNull(),
    createdAt,
  },
  t => [
    // One original per platform, and one republish per (platform, update it re-dates) —
    // several channels can serve different updates a rollback must return to.
    unique('mocco_ota_updates_release_platform_kind_uq')
      .on(t.releaseId, t.platform, t.kind, t.supersedesUpdateId, t.contentOfUpdateId)
      .nullsNotDistinct(),
    index('mocco_ota_updates_app_platform_runtime_idx').on(t.appId, t.platform, t.runtimeVersion, t.commitTime),
    foreignKey({
      columns: [t.releaseId, t.workspaceId],
      foreignColumns: [otaReleases.id, otaReleases.workspaceId],
      name: 'mocco_ota_updates_release_fk',
    }).onDelete('cascade'),
    check('mocco_ota_updates_platform_check', sql`${t.platform} IN (${sqlInList(Object.values(OtaPlatforms))})`),
    check('mocco_ota_updates_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(OtaUpdateKinds))})`),
  ],
);

export const otaSignedDirectives = pgTable(
  'mocco_ota_signed_directives',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    releaseId: uuid('release_id'),
    platform: text().$type<OtaPlatform>().notNull(),
    runtimeVersion: text('runtime_version').notNull(),
    type: text().$type<OtaDirectiveType>().notNull(),
    commitTime: timestamp('commit_time', { withTimezone: true }),
    supersedesUpdateId: uuid('supersedes_update_id'),
    body: text().notNull(),
    signature: text(),
    keyid: text(),
    createdAt,
  },
  t => [
    index('mocco_ota_signed_directives_app_idx').on(t.appId, t.platform, t.runtimeVersion, t.type),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_signed_directives_app_fk',
    }).onDelete('cascade'),
    check('mocco_ota_signed_directives_type_check', sql`${t.type} IN (${sqlInList(Object.values(OtaDirectiveTypes))})`),
    check(
      'mocco_ota_signed_directives_platform_check',
      sql`${t.platform} IN (${sqlInList(Object.values(OtaPlatforms))})`,
    ),
  ],
);

/** Content-addressed assets, deduplicated across an app's releases. */
export const otaAssets = pgTable(
  'mocco_ota_assets',
  {
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    // base64url SHA-256 without padding, as expo-updates checks it.
    hash: text().notNull(),
    contentType: text('content_type').notNull(),
    fileExtension: text('file_extension'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    // Null until uploaded, and again if storage gc drops an abandoned upload.
    objectId: uuid('object_id').references(() => objects.id, { onDelete: 'set null' }),
    verifiedAt: timestamp('verified_at'),
    createdAt,
  },
  t => [
    primaryKey({ columns: [t.appId, t.hash], name: 'mocco_ota_assets_pk' }),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_assets_app_fk',
    }).onDelete('cascade'),
  ],
);

export const otaUpdateAssets = pgTable(
  'mocco_ota_update_assets',
  {
    updateId: uuid('update_id')
      .notNull()
      .references(() => otaUpdates.id, { onDelete: 'cascade' }),
    appId: uuid('app_id').notNull(),
    assetHash: text('asset_hash').notNull(),
    key: text().notNull(),
    isLaunch: boolean('is_launch').notNull().default(false),
  },
  t => [primaryKey({ columns: [t.updateId, t.assetHash], name: 'mocco_ota_update_assets_pk' })],
);

/** The serving state of a channel per platform and runtime version. */
export const otaChannelHeads = pgTable(
  'mocco_ota_channel_heads',
  {
    workspaceId: uuid('workspace_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    platform: text().$type<OtaPlatform>().notNull(),
    runtimeVersion: text('runtime_version').notNull(),
    activeUpdateId: uuid('active_update_id').references(() => otaUpdates.id, { onDelete: 'set null' }),
    candidateUpdateId: uuid('candidate_update_id').references(() => otaUpdates.id, { onDelete: 'set null' }),
    // What `active` replaced: a rollback serves the pre-signed republish of its content.
    previousUpdateId: uuid('previous_update_id').references(() => otaUpdates.id, { onDelete: 'set null' }),
    // Basis points of devices that get the candidate (0..10000).
    rolloutBp: smallint('rollout_bp').notNull().default(0),
    rolloutSalt: text('rollout_salt').notNull(),
    isPaused: boolean('is_paused').notNull().default(false),
    // Set while the head serves a roll-back-to-embedded directive.
    serveDirectiveId: uuid('serve_directive_id').references(() => otaSignedDirectives.id, { onDelete: 'set null' }),
    // Incremented on every change: the serving cache key.
    version: bigint({ mode: 'number' }).notNull().default(1),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [
    primaryKey({ columns: [t.channelId, t.platform, t.runtimeVersion], name: 'mocco_ota_channel_heads_pk' }),
    foreignKey({
      columns: [t.channelId, t.workspaceId],
      foreignColumns: [otaChannels.id, otaChannels.workspaceId],
      name: 'mocco_ota_channel_heads_channel_fk',
    }).onDelete('cascade'),
    check('mocco_ota_channel_heads_rollout_check', sql`${t.rolloutBp} BETWEEN 0 AND 10000`),
    check('mocco_ota_channel_heads_platform_check', sql`${t.platform} IN (${sqlInList(Object.values(OtaPlatforms))})`),
  ],
);

/** Append-only history of channel changes. */
export const otaDeployments = pgTable(
  'mocco_ota_deployments',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    releaseId: uuid('release_id').references(() => otaReleases.id, { onDelete: 'set null' }),
    kind: text().$type<OtaDeploymentKind>().notNull(),
    fromBp: smallint('from_bp'),
    toBp: smallint('to_bp'),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actorPrincipal: text('actor_principal'),
    approvalRequestId: uuid('approval_request_id').references(() => approvalRequests.id, { onDelete: 'set null' }),
    reason: text(),
    createdAt,
  },
  t => [
    index('mocco_ota_deployments_channel_idx').on(t.channelId, t.createdAt),
    foreignKey({
      columns: [t.channelId, t.workspaceId],
      foreignColumns: [otaChannels.id, otaChannels.workspaceId],
      name: 'mocco_ota_deployments_channel_fk',
    }).onDelete('cascade'),
    check('mocco_ota_deployments_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(OtaDeploymentKinds))})`),
  ],
);

/**
 * Trusted publishing (OTA design §6.2): a GitHub repository — by numeric id, so a rename
 * can't hijack it — and ref (and optionally workflow and environment) whose Actions OIDC
 * tokens may mint upload sessions, and the unprotected channels those may promote to.
 */
export const otaTrustPolicies = pgTable(
  'mocco_ota_trust_policies',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    provider: text().notNull().default('github'),
    repositoryId: bigint('repository_id', { mode: 'bigint' }).notNull(),
    // The owner/name when the policy was made, for display only.
    repository: text().notNull(),
    refPattern: text('ref_pattern').notNull(),
    workflowRef: text('workflow_ref'),
    environment: text(),
    allowedChannels: text('allowed_channels')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  t => [
    unique('mocco_ota_trust_policies_id_workspace_uq').on(t.id, t.workspaceId),
    index('mocco_ota_trust_policies_app_idx').on(t.appId, t.repositoryId),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_trust_policies_app_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Short-lived upload credentials for CI (OTA design §6.2). A session is minted from a
 * secret API key with `ota:write`, a GitHub OIDC token matching a trust policy, or a
 * broker-approved run step; only the token's hash is stored. One session uploads at most one release.
 */
export const otaUploadSessions = pgTable(
  'mocco_ota_upload_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    tokenHash: text('token_hash').notNull().unique('mocco_ota_upload_sessions_token_hash_uq'),
    // Who the session speaks for, e.g. `apikey:<id>` or `github:repo:123:ref:refs/heads/main`.
    principal: text().notNull(),
    apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    trustPolicyId: uuid('trust_policy_id').references(() => otaTrustPolicies.id, { onDelete: 'set null' }),
    // Channels the session may promote to; null for any unprotected one (a key or a broker run).
    allowedChannels: text('allowed_channels').array(),
    // The person the session acts for (the key's creator, the run's trigger), so a
    // request from CI can't be approved by that same person.
    actingUserId: uuid('acting_user_id').references(() => users.id, { onDelete: 'set null' }),
    releaseId: uuid('release_id').references(() => otaReleases.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt,
  },
  t => [
    index('mocco_ota_upload_sessions_expires_idx').on(t.expiresAt),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_upload_sessions_app_fk',
    }).onDelete('cascade'),
  ],
);

/** The latest state of each install, from update checks (OTA design §4.1). The client id
 * is stored only as a peppered hash; no IP address is stored. */
export const otaDevices = pgTable(
  'mocco_ota_devices',
  {
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    clientIdHash: text('client_id_hash').notNull(),
    platform: text().$type<OtaPlatform>().notNull(),
    runtimeVersion: text('runtime_version').notNull(),
    channel: text().notNull(),
    // No FK: a device may report an update that was never Mocco's (the embedded one).
    currentUpdateId: uuid('current_update_id'),
    embeddedUpdateId: uuid('embedded_update_id'),
    firstSeenAt: timestamp('first_seen_at').notNull(),
    lastSeenAt: timestamp('last_seen_at').notNull(),
  },
  t => [
    primaryKey({ columns: [t.appId, t.clientIdHash], name: 'mocco_ota_devices_pk' }),
    index('mocco_ota_devices_update_idx').on(t.appId, t.currentUpdateId, t.lastSeenAt),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_devices_app_fk',
    }).onDelete('cascade'),
  ],
);

/** What apps report from devices: launches, emergency launches, errors. Pruned after 90 days. */
export const otaClientEvents = pgTable(
  'mocco_ota_client_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    updateId: uuid('update_id'),
    clientIdHash: text('client_id_hash').notNull(),
    type: text().$type<OtaClientEventType>().notNull(),
    detail: jsonb().$type<Record<string, string | number | boolean>>(),
    occurredAt: timestamp('occurred_at').notNull(),
    createdAt,
  },
  t => [
    index('mocco_ota_client_events_app_idx').on(t.appId, t.updateId, t.occurredAt),
    index('mocco_ota_client_events_occurred_idx').on(t.occurredAt),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_client_events_app_fk',
    }).onDelete('cascade'),
    check('mocco_ota_client_events_type_check', sql`${t.type} IN (${sqlInList(Object.values(OtaClientEventTypes))})`),
  ],
);

/** Daily adoption per update, rolled up by the `ota.rollupMetrics` job. */
export const otaAdoptionDaily = pgTable(
  'mocco_ota_adoption_daily',
  {
    workspaceId: uuid('workspace_id').notNull(),
    appId: uuid('app_id').notNull(),
    updateId: uuid('update_id').notNull(),
    day: date({ mode: 'string' }).notNull(),
    activeDevices: integer('active_devices').notNull().default(0),
    newDevices: integer('new_devices').notNull().default(0),
    emergencyLaunches: integer('emergency_launches').notNull().default(0),
  },
  t => [
    primaryKey({ columns: [t.appId, t.updateId, t.day], name: 'mocco_ota_adoption_daily_pk' }),
    foreignKey({
      columns: [t.appId, t.workspaceId],
      foreignColumns: [otaApps.id, otaApps.workspaceId],
      name: 'mocco_ota_adoption_daily_app_fk',
    }).onDelete('cascade'),
  ],
);

/** A project's help center (#96): its public slug and languages. One per project. */
export const helpSites = pgTable(
  'mocco_help_sites',
  {
    projectId: uuid('project_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    // The public label: `<slug>.help.<mocco domain>`, until a custom domain is bound.
    slug: text().notNull(),
    sourceLocale: text('source_locale').notNull(),
    // The languages articles are translated into (never the source).
    locales: text().array().notNull(),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_help_sites_slug_uq').on(t.slug),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_help_sites_project_fk',
    }).onDelete('cascade'),
  ],
);

/** The top level of a help site (a tab: "Getting started", "Guides"). */
export const helpCollections = pgTable(
  'mocco_help_collections',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    slug: text().notNull(),
    title: text().notNull(),
    description: text(),
    position: integer().notNull(),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_help_collections_project_slug_uq').on(t.projectId, t.slug),
    unique('mocco_help_collections_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.projectId],
      foreignColumns: [helpSites.projectId],
      name: 'mocco_help_collections_site_fk',
    }).onDelete('cascade'),
  ],
);

/** A group of articles inside a collection. */
export const helpSections = pgTable(
  'mocco_help_sections',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    collectionId: uuid('collection_id').notNull(),
    title: text().notNull(),
    position: integer().notNull(),
    createdAt,
    updatedAt,
  },
  t => [
    index('mocco_help_sections_collection_position_idx').on(t.collectionId, t.position),
    unique('mocco_help_sections_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.collectionId, t.workspaceId],
      foreignColumns: [helpCollections.id, helpCollections.workspaceId],
      name: 'mocco_help_sections_collection_fk',
    }).onDelete('cascade'),
  ],
);

/** An article. Its text lives in revisions; `short_id` is the stable public URL key. */
export const helpArticles = pgTable(
  'mocco_help_articles',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    sectionId: uuid('section_id').notNull(),
    shortId: text('short_id').notNull(),
    slug: text().notNull(),
    position: integer().notNull(),
    status: text().$type<ArticleStatus>().notNull(),
    draftRevisionId: uuid('draft_revision_id'),
    publishedRevisionId: uuid('published_revision_id'),
    publishedAt: timestamp('published_at'),
    publishedByUserId: uuid('published_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_help_articles_project_short_uq').on(t.projectId, t.shortId),
    index('mocco_help_articles_section_position_idx').on(t.sectionId, t.position),
    unique('mocco_help_articles_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.sectionId, t.workspaceId],
      foreignColumns: [helpSections.id, helpSections.workspaceId],
      name: 'mocco_help_articles_section_fk',
    }).onDelete('cascade'),
    check('mocco_help_articles_status_check', sql`${t.status} IN (${sqlInList(Object.values(ArticleStatuses))})`),
  ],
);

/** Append-only text of an article in one language: every save, import and restore. */
export const helpRevisions = pgTable(
  'mocco_help_revisions',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    articleId: uuid('article_id').notNull(),
    locale: text().notNull(),
    title: text().notNull(),
    bodyMd: text('body_md').notNull(),
    // sha256 of the normalized title and body; translations compare against it later.
    contentHash: text('content_hash').notNull(),
    kind: text().$type<RevisionKind>().notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  t => [
    index('mocco_help_revisions_article_locale_created_idx').on(t.articleId, t.locale, t.createdAt),
    foreignKey({
      columns: [t.articleId, t.workspaceId],
      foreignColumns: [helpArticles.id, helpArticles.workspaceId],
      name: 'mocco_help_revisions_article_fk',
    }).onDelete('cascade'),
    check('mocco_help_revisions_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(RevisionKinds))})`),
  ],
);

/** An article's translation into one language: its state and current text (a revision in that language). */
export const helpTranslations = pgTable(
  'mocco_help_translations',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    articleId: uuid('article_id').notNull(),
    locale: text().notNull(),
    state: text().$type<TranslationState>().notNull(),
    revisionId: uuid('revision_id'),
    // The published source's content hash this text was made from; a newer source makes it stale.
    sourceHash: text('source_hash'),
    lastError: text('last_error'),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_help_translations_article_locale_uq').on(t.articleId, t.locale),
    foreignKey({
      columns: [t.articleId, t.workspaceId],
      foreignColumns: [helpArticles.id, helpArticles.workspaceId],
      name: 'mocco_help_translations_article_fk',
    }).onDelete('cascade'),
    check('mocco_help_translations_state_check', sql`${t.state} IN (${sqlInList(Object.values(TranslationStates))})`),
  ],
);

/** A collection's or section's title in another language (machine-translated with its articles). */
export const helpNodeTranslations = pgTable(
  'mocco_help_node_translations',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    collectionId: uuid('collection_id'),
    sectionId: uuid('section_id'),
    locale: text().notNull(),
    title: text().notNull(),
    // The source title this was made from; a renamed node is translated again.
    sourceTitle: text('source_title').notNull(),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_help_node_translations_collection_uq').on(t.collectionId, t.locale),
    uniqueIndex('mocco_help_node_translations_section_uq').on(t.sectionId, t.locale),
    foreignKey({
      columns: [t.collectionId, t.workspaceId],
      foreignColumns: [helpCollections.id, helpCollections.workspaceId],
      name: 'mocco_help_node_translations_collection_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.sectionId, t.workspaceId],
      foreignColumns: [helpSections.id, helpSections.workspaceId],
      name: 'mocco_help_node_translations_section_fk',
    }).onDelete('cascade'),
    check('mocco_help_node_translations_node_check', sql`(${t.collectionId} IS NULL) <> (${t.sectionId} IS NULL)`),
  ],
);

/** Old paths (an imported site's URLs) that redirect to an article. */
export const helpRedirects = pgTable(
  'mocco_help_redirects',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    fromPath: text('from_path').notNull(),
    articleId: uuid('article_id').notNull(),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_help_redirects_project_path_uq').on(t.projectId, t.fromPath),
    foreignKey({
      columns: [t.articleId, t.workspaceId],
      foreignColumns: [helpArticles.id, helpArticles.workspaceId],
      name: 'mocco_help_redirects_article_fk',
    }).onDelete('cascade'),
  ],
);

// ─────────────────────────────────────────────────────────────
// MCP (ADR 0025): per-workspace settings for the agent surface. The tokens and clients
// themselves are the authorization server's tables above; this is what a workspace
// decides about agents.
// ─────────────────────────────────────────────────────────────

/** A workspace's MCP settings. No row means the defaults: agents read, never decide. */
export const mcpSettings = pgTable('mocco_mcp_settings', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  agentsMayDecide: boolean('agents_may_decide').notNull().default(false),
  changedAt: timestamp('changed_at').notNull().defaultNow(),
  // SET NULL: the setting outlives the person who switched it; the audit chain keeps who.
  changedByUserId: uuid('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
});

// ─────────────────────────────────────────────────────────────
// Status page (#103, slice #148): a project's status pages, their components, incidents and
// scheduled maintenance, managed by hand. Every row carries `workspace_id`; children reach their
// page through composite FKs on (page_id, workspace_id, project_id), so a row can never point
// at another tenant's page. Monitors, subscribers, snapshots and run links come in later slices.
// ─────────────────────────────────────────────────────────────

/** A status page of a project. `slug` is global: it becomes the public host label. */
export const statusPages = pgTable(
  'mocco_status_pages',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    slug: text().notNull(),
    title: text().notNull(),
    // Set by every change that affects the public page; the snapshot publish job clears it.
    dirtyAt: timestamp('dirty_at'),
    publishedAt: timestamp('published_at'),
    publishedVersion: integer('published_version'),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_status_pages_slug_uq').on(t.slug),
    index('mocco_status_pages_project_idx').on(t.projectId),
    // A UNIQUE CONSTRAINT so children's composite FKs can reference (id, workspace_id, project_id).
    unique('mocco_status_pages_scope_uq').on(t.id, t.workspaceId, t.projectId),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_status_pages_project_fk',
    }).onDelete('cascade'),
    check('mocco_status_pages_slug_check', sql`${t.slug} ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'`),
  ],
);

/** A heading that groups a page's components ("API", "Dashboard"). */
export const statusComponentGroups = pgTable(
  'mocco_status_component_groups',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    pageId: uuid('page_id').notNull(),
    name: text().notNull(),
    position: integer().notNull(),
    createdAt,
    updatedAt,
  },
  t => [
    index('mocco_status_component_groups_page_idx').on(t.pageId, t.position),
    // Lets a component's group FK require the group to be on the component's page.
    unique('mocco_status_component_groups_id_page_uq').on(t.id, t.pageId),
    foreignKey({
      columns: [t.pageId, t.workspaceId, t.projectId],
      foreignColumns: [statusPages.id, statusPages.workspaceId, statusPages.projectId],
      name: 'mocco_status_component_groups_page_fk',
    }).onDelete('cascade'),
  ],
);

/** A part of the service a page reports on. `status` is the one an operator sets by hand; the
 * displayed status also counts open incidents and maintenance in progress (ComponentStatusService). */
export const statusComponents = pgTable(
  'mocco_status_components',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    pageId: uuid('page_id').notNull(),
    // Null = ungrouped. Deleting a group ungroups its components first (ComponentGroupRepo.delete).
    groupId: uuid('group_id'),
    name: text().notNull(),
    description: text(),
    position: integer().notNull(),
    status: text().$type<ComponentStatus>().notNull().default(ComponentStatuses.operational),
    createdAt,
    updatedAt,
  },
  t => [
    index('mocco_status_components_page_idx').on(t.pageId, t.position),
    // Lets incident and maintenance links reference (component_id, workspace_id).
    unique('mocco_status_components_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.pageId, t.workspaceId, t.projectId],
      foreignColumns: [statusPages.id, statusPages.workspaceId, statusPages.projectId],
      name: 'mocco_status_components_page_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.groupId, t.pageId],
      foreignColumns: [statusComponentGroups.id, statusComponentGroups.pageId],
      name: 'mocco_status_components_group_fk',
    }),
    check('mocco_status_components_status_check', sql`${t.status} IN (${sqlInList(Object.values(ComponentStatuses))})`),
  ],
);

/** An incident on a page. Invariant (DB-checked): `resolved_at` is set iff `status = 'resolved'`. */
export const statusIncidents = pgTable(
  'mocco_status_incidents',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    pageId: uuid('page_id').notNull(),
    title: text().notNull(),
    status: text().$type<IncidentStatus>().notNull(),
    severity: text().$type<IncidentSeverity>().notNull(),
    visibility: text().$type<IncidentVisibility>().notNull().default(IncidentVisibilities.published),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    identifiedAt: timestamp('identified_at'),
    resolvedAt: timestamp('resolved_at'),
    postmortemMd: text('postmortem_md'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  t => [
    index('mocco_status_incidents_workspace_status_idx').on(t.workspaceId, t.status),
    index('mocco_status_incidents_page_started_idx').on(t.pageId, t.startedAt),
    unique('mocco_status_incidents_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.pageId, t.workspaceId, t.projectId],
      foreignColumns: [statusPages.id, statusPages.workspaceId, statusPages.projectId],
      name: 'mocco_status_incidents_page_fk',
    }).onDelete('cascade'),
    check('mocco_status_incidents_status_check', sql`${t.status} IN (${sqlInList(Object.values(IncidentStatuses))})`),
    check(
      'mocco_status_incidents_severity_check',
      sql`${t.severity} IN (${sqlInList(Object.values(IncidentSeverities))})`,
    ),
    check(
      'mocco_status_incidents_visibility_check',
      sql`${t.visibility} IN (${sqlInList(Object.values(IncidentVisibilities))})`,
    ),
    check(
      'mocco_status_incidents_resolved_check',
      sql`(${t.status} IN (${sqlInList([IncidentStatuses.resolved])})) = (${t.resolvedAt} IS NOT NULL)`,
    ),
  ],
);

/** An incident's timeline. Append-only; each entry is also in the audit log. */
export const statusIncidentUpdates = pgTable(
  'mocco_status_incident_updates',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    incidentId: uuid('incident_id').notNull(),
    status: text().$type<IncidentStatus>().notNull(),
    bodyMd: text('body_md').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
  },
  t => [
    index('mocco_status_incident_updates_incident_idx').on(t.incidentId, t.createdAt),
    foreignKey({
      columns: [t.incidentId, t.workspaceId],
      foreignColumns: [statusIncidents.id, statusIncidents.workspaceId],
      name: 'mocco_status_incident_updates_incident_fk',
    }).onDelete('cascade'),
    check(
      'mocco_status_incident_updates_status_check',
      sql`${t.status} IN (${sqlInList(Object.values(IncidentStatuses))})`,
    ),
  ],
);

/** The components an incident affects, and how badly. */
export const statusIncidentComponents = pgTable(
  'mocco_status_incident_components',
  {
    incidentId: uuid('incident_id').notNull(),
    componentId: uuid('component_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    impact: text().$type<ComponentImpact>().notNull(),
    createdAt,
  },
  t => [
    primaryKey({ name: 'mocco_status_incident_components_pk', columns: [t.incidentId, t.componentId] }),
    index('mocco_status_incident_components_component_idx').on(t.componentId),
    foreignKey({
      columns: [t.incidentId, t.workspaceId],
      foreignColumns: [statusIncidents.id, statusIncidents.workspaceId],
      name: 'mocco_status_incident_components_incident_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.componentId, t.workspaceId],
      foreignColumns: [statusComponents.id, statusComponents.workspaceId],
      name: 'mocco_status_incident_components_component_fk',
    }).onDelete('cascade'),
    check(
      'mocco_status_incident_components_impact_check',
      sql`${t.impact} IN (${sqlInList(Object.values(ComponentImpacts))})`,
    ),
  ],
);

/** A scheduled maintenance window on a page. The maintenance tick starts and completes it. */
export const statusMaintenances = pgTable(
  'mocco_status_maintenances',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    pageId: uuid('page_id').notNull(),
    title: text().notNull(),
    bodyMd: text('body_md').notNull().default(''),
    status: text().$type<MaintenanceStatus>().notNull().default(MaintenanceStatuses.scheduled),
    scheduledStart: timestamp('scheduled_start').notNull(),
    scheduledEnd: timestamp('scheduled_end').notNull(),
    actualStart: timestamp('actual_start'),
    actualEnd: timestamp('actual_end'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  t => [
    index('mocco_status_maintenances_page_start_idx').on(t.pageId, t.scheduledStart),
    // The tick's scan: windows still to start or complete.
    index('mocco_status_maintenances_due_idx')
      .on(t.scheduledStart, t.scheduledEnd)
      .where(sql`${t.status} IN (${sqlInList([MaintenanceStatuses.scheduled, MaintenanceStatuses.inProgress])})`),
    unique('mocco_status_maintenances_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.pageId, t.workspaceId, t.projectId],
      foreignColumns: [statusPages.id, statusPages.workspaceId, statusPages.projectId],
      name: 'mocco_status_maintenances_page_fk',
    }).onDelete('cascade'),
    check(
      'mocco_status_maintenances_status_check',
      sql`${t.status} IN (${sqlInList(Object.values(MaintenanceStatuses))})`,
    ),
    check('mocco_status_maintenances_window_check', sql`${t.scheduledEnd} > ${t.scheduledStart}`),
  ],
);

/** The components a maintenance window covers. */
export const statusMaintenanceComponents = pgTable(
  'mocco_status_maintenance_components',
  {
    maintenanceId: uuid('maintenance_id').notNull(),
    componentId: uuid('component_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    createdAt,
  },
  t => [
    primaryKey({ name: 'mocco_status_maintenance_components_pk', columns: [t.maintenanceId, t.componentId] }),
    index('mocco_status_maintenance_components_component_idx').on(t.componentId),
    foreignKey({
      columns: [t.maintenanceId, t.workspaceId],
      foreignColumns: [statusMaintenances.id, statusMaintenances.workspaceId],
      name: 'mocco_status_maintenance_components_maintenance_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.componentId, t.workspaceId],
      foreignColumns: [statusComponents.id, statusComponents.workspaceId],
      name: 'mocco_status_maintenance_components_component_fk',
    }).onDelete('cascade'),
  ],
);

/** A published version of a status page's public snapshot (ADR 0028). The last twenty are kept,
 * so a page can be rolled back and a self-hoster can rebuild the public directory. */
export const statusPageSnapshots = pgTable(
  'mocco_status_page_snapshots',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    pageId: uuid('page_id').notNull(),
    version: integer().notNull(),
    etag: text().notNull(),
    body: jsonb().notNull(),
    builtAt: timestamp('built_at').notNull(),
    uploadedAt: timestamp('uploaded_at'),
    uploadError: text('upload_error'),
    createdAt,
  },
  t => [
    uniqueIndex('mocco_status_page_snapshots_page_version_uq').on(t.pageId, t.version),
    foreignKey({
      columns: [t.pageId, t.workspaceId, t.projectId],
      foreignColumns: [statusPages.id, statusPages.workspaceId, statusPages.projectId],
      name: 'mocco_status_page_snapshots_page_fk',
    }).onDelete('cascade'),
  ],
);

// ─────────────────────────────────────────────────────────────
// Status monitors (#150): HTTP and TCP checks of a project, run by `@mocco/probe` agents at
// the locations they are assigned to (ADR 0027). A location is a hosted region (no
// workspace) or a workspace's private location; its token is stored only as a SHA-256 hash.
// The lease, result and verdict time series come with the probe protocol.
// ─────────────────────────────────────────────────────────────

/** Where probes run. `workspace_id` is null for Mocco's hosted regions and an embedded probe,
 * which may check any workspace's monitors; a private location checks only its workspace's. */
export const statusLocations = pgTable(
  'mocco_status_locations',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    code: text().notNull(),
    name: text().notNull(),
    kind: text().$type<LocationKind>().notNull(),
    tokenHash: text('token_hash').notNull(),
    lastSeenAt: timestamp('last_seen_at'),
    agentVersion: text('agent_version'),
    disabledAt: timestamp('disabled_at'),
    createdAt,
    updatedAt,
  },
  t => [
    uniqueIndex('mocco_status_locations_token_hash_uq').on(t.tokenHash),
    uniqueIndex('mocco_status_locations_workspace_code_uq')
      .on(t.workspaceId, t.code)
      .where(sql`${t.workspaceId} IS NOT NULL`),
    uniqueIndex('mocco_status_locations_global_code_uq')
      .on(t.code)
      .where(sql`${t.workspaceId} IS NULL`),
    check('mocco_status_locations_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(LocationKinds))})`),
    // Only a private location belongs to a workspace.
    check(
      'mocco_status_locations_scope_check',
      sql`(${t.kind} IN (${sqlInList([LocationKinds.private])})) = (${t.workspaceId} IS NOT NULL)`,
    ),
  ],
);

/** An HTTP or TCP check of a project. `state` is written only by the evaluator and by pause and
 * resume, both under the monitor's advisory lock; `next_round_at` is the probes' schedule. */
export const statusMonitors = pgTable(
  'mocco_status_monitors',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    name: text().notNull(),
    kind: text().$type<MonitorKind>().notNull(),
    spec: jsonb().$type<MonitorSpec>().notNull(),
    intervalSeconds: integer('interval_s').notNull(),
    confirmations: integer().notNull(),
    recoveryConfirmations: integer('recovery_confirmations').notNull(),
    quorumMode: text('quorum_mode').$type<QuorumMode>().notNull(),
    state: text().$type<MonitorState>().notNull().default(MonitorStates.pending),
    stateChangedAt: timestamp('state_changed_at').notNull().defaultNow(),
    nextRoundAt: timestamp('next_round_at').notNull().defaultNow(),
    /** Consecutive failing and passing verdicts, for `confirmations` and `recovery_confirmations`. */
    consecutiveFails: integer('consecutive_fails').notNull().default(0),
    consecutiveOks: integer('consecutive_oks').notNull().default(0),
    /** What going down does to the page: no incident, a draft one, or a published one. */
    incidentPolicy: text('incident_policy').$type<IncidentPolicy>().notNull().default(IncidentPolicies.draft),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt,
    updatedAt,
  },
  t => [
    index('mocco_status_monitors_project_idx').on(t.workspaceId, t.projectId),
    // The probes' lease scan: rounds coming due on monitors that aren't paused.
    index('mocco_status_monitors_next_round_idx')
      .on(t.nextRoundAt)
      .where(sql`${t.state} NOT IN (${sqlInList([MonitorStates.paused])})`),
    // Lets locations, components and state changes reference (monitor_id, workspace_id).
    unique('mocco_status_monitors_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      columns: [t.projectId, t.workspaceId],
      foreignColumns: [projects.id, projects.workspaceId],
      name: 'mocco_status_monitors_project_fk',
    }).onDelete('cascade'),
    check('mocco_status_monitors_kind_check', sql`${t.kind} IN (${sqlInList(Object.values(MonitorKinds))})`),
    check('mocco_status_monitors_state_check', sql`${t.state} IN (${sqlInList(Object.values(MonitorStates))})`),
    check(
      'mocco_status_monitors_quorum_mode_check',
      sql`${t.quorumMode} IN (${sqlInList(Object.values(QuorumModes))})`,
    ),
    check('mocco_status_monitors_interval_check', sql`${t.intervalSeconds} >= 60`),
    check(
      'mocco_status_monitors_incident_policy_check',
      sql`${t.incidentPolicy} IN (${sqlInList(Object.values(IncidentPolicies))})`,
    ),
    check(
      'mocco_status_monitors_confirmations_check',
      sql`${t.confirmations} >= 1 AND ${t.recoveryConfirmations} >= 1`,
    ),
  ],
);

/** The locations a monitor runs at. The service allows hosted locations and the workspace's own. */
export const statusMonitorLocations = pgTable(
  'mocco_status_monitor_locations',
  {
    monitorId: uuid('monitor_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => statusLocations.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    createdAt,
  },
  t => [
    primaryKey({ name: 'mocco_status_monitor_locations_pk', columns: [t.monitorId, t.locationId] }),
    index('mocco_status_monitor_locations_location_idx').on(t.locationId),
    foreignKey({
      columns: [t.monitorId, t.workspaceId],
      foreignColumns: [statusMonitors.id, statusMonitors.workspaceId],
      name: 'mocco_status_monitor_locations_monitor_fk',
    }).onDelete('cascade'),
  ],
);

/** The components a monitor reports on, and what a component shows while the monitor is down. */
export const statusComponentMonitors = pgTable(
  'mocco_status_component_monitors',
  {
    componentId: uuid('component_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    impactWhenDown: text('impact_when_down').$type<ComponentImpact>().notNull(),
    createdAt,
  },
  t => [
    primaryKey({ name: 'mocco_status_component_monitors_pk', columns: [t.componentId, t.monitorId] }),
    index('mocco_status_component_monitors_monitor_idx').on(t.monitorId),
    foreignKey({
      columns: [t.componentId, t.workspaceId],
      foreignColumns: [statusComponents.id, statusComponents.workspaceId],
      name: 'mocco_status_component_monitors_component_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.monitorId, t.workspaceId],
      foreignColumns: [statusMonitors.id, statusMonitors.workspaceId],
      name: 'mocco_status_component_monitors_monitor_fk',
    }).onDelete('cascade'),
    check(
      'mocco_status_component_monitors_impact_check',
      sql`${t.impactWhenDown} IN (${sqlInList(Object.values(ComponentImpacts))})`,
    ),
  ],
);

/** The incident a monitor opened when it went down. The link closes when the monitor recovers
 * (or the incident was resolved by hand), so a monitor has at most one open incident. */
export const statusIncidentMonitors = pgTable(
  'mocco_status_incident_monitors',
  {
    incidentId: uuid('incident_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    closedAt: timestamp('closed_at'),
    createdAt,
  },
  t => [
    primaryKey({ name: 'mocco_status_incident_monitors_pk', columns: [t.incidentId, t.monitorId] }),
    uniqueIndex('mocco_status_incident_monitors_open_uq')
      .on(t.monitorId)
      .where(sql`${t.closedAt} IS NULL`),
    foreignKey({
      columns: [t.incidentId, t.workspaceId],
      foreignColumns: [statusIncidents.id, statusIncidents.workspaceId],
      name: 'mocco_status_incident_monitors_incident_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.monitorId, t.workspaceId],
      foreignColumns: [statusMonitors.id, statusMonitors.workspaceId],
      name: 'mocco_status_incident_monitors_monitor_fk',
    }).onDelete('cascade'),
  ],
);

/** Every change of a monitor's state: the source of truth for downtime (an outage runs from
 * `down` to the next `up`). Append-only; `round_at` is the round that caused it, if any. */
export const statusMonitorStateChanges = pgTable(
  'mocco_status_monitor_state_changes',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    fromState: text('from_state').$type<MonitorState>().notNull(),
    toState: text('to_state').$type<MonitorState>().notNull(),
    at: timestamp().notNull(),
    roundAt: timestamp('round_at'),
    reason: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  t => [
    index('mocco_status_monitor_state_changes_monitor_at_idx').on(t.monitorId, t.at),
    foreignKey({
      columns: [t.monitorId, t.workspaceId],
      foreignColumns: [statusMonitors.id, statusMonitors.workspaceId],
      name: 'mocco_status_monitor_state_changes_monitor_fk',
    }).onDelete('cascade'),
    check(
      'mocco_status_monitor_state_changes_from_check',
      sql`${t.fromState} IN (${sqlInList(Object.values(MonitorStates))})`,
    ),
    check(
      'mocco_status_monitor_state_changes_to_check',
      sql`${t.toState} IN (${sqlInList(Object.values(MonitorStates))})`,
    ),
  ],
);

/** One check a location owes for one round of a monitor. The unique (monitor, location, round)
 * makes assignment idempotent: two agents of a location can never lease the same round twice. */
export const statusProbeLeases = pgTable(
  'mocco_status_probe_leases',
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    monitorId: uuid('monitor_id').notNull(),
    locationId: uuid('location_id')
      .notNull()
      .references(() => statusLocations.id, { onDelete: 'cascade' }),
    roundAt: timestamp('round_at').notNull(),
    leasedAt: timestamp('leased_at').notNull(),
    /** Results are refused after this; an unreported lease then counts as `no_data`. */
    expiresAt: timestamp('expires_at').notNull(),
    reportedAt: timestamp('reported_at'),
  },
  t => [
    uniqueIndex('mocco_status_probe_leases_monitor_location_round_uq').on(t.monitorId, t.locationId, t.roundAt),
    index('mocco_status_probe_leases_location_idx').on(t.locationId, t.roundAt),
    foreignKey({
      columns: [t.monitorId, t.workspaceId],
      foreignColumns: [statusMonitors.id, statusMonitors.workspaceId],
      name: 'mocco_status_probe_leases_monitor_fk',
    }).onDelete('cascade'),
  ],
);

/**
 * Raw check results, one per (monitor, round, location). Range-partitioned by `round_at`, one
 * partition per UTC day: migration 0057 turns this table into the partitioned parent (drizzle
 * can't declare partitioning), and the `status.retention` job creates the coming days'
 * partitions and drops those past retention. No uuid PK and no foreign keys, like the audit
 * log's documented exception: an append-only time series dropped a day at a time.
 */
export const statusCheckResults = pgTable(
  'mocco_status_check_results',
  {
    monitorId: uuid('monitor_id').notNull(),
    roundAt: timestamp('round_at').notNull(),
    locationId: uuid('location_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    leaseId: uuid('lease_id').notNull(),
    outcome: text().$type<CheckOutcome>().notNull(),
    errorKind: text('error_kind').$type<CheckErrorKind>(),
    statusCode: smallint('status_code'),
    latencyMs: integer('latency_ms'),
    timings: jsonb().$type<Record<string, number>>(),
    tlsExpiresAt: timestamp('tls_expires_at'),
    detail: text(),
    receivedAt: timestamp('received_at').notNull(),
  },
  t => [
    primaryKey({ name: 'mocco_status_check_results_pk', columns: [t.monitorId, t.roundAt, t.locationId] }),
    index('mocco_status_check_results_workspace_round_idx').on(t.workspaceId, t.roundAt),
    check(
      'mocco_status_check_results_outcome_check',
      sql`${t.outcome} IN (${sqlInList(Object.values(CheckOutcomes))})`,
    ),
    check(
      'mocco_status_check_results_error_kind_check',
      sql`${t.errorKind} IS NULL OR ${t.errorKind} IN (${sqlInList(Object.values(CheckErrorKinds))})`,
    ),
  ],
);

/**
 * One closed round of a monitor: what its locations agreed on. Partitioned by UTC day on
 * `round_at` like the raw results (custom migration 0059), and dropped a day at a time after 30
 * days by the `status.retention` job; state changes, not verdicts, are the record of downtime.
 */
export const statusRoundVerdicts = pgTable(
  'mocco_status_round_verdicts',
  {
    monitorId: uuid('monitor_id').notNull(),
    roundAt: timestamp('round_at').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    verdict: text().$type<RoundVerdict>().notNull(),
    okCount: integer('ok_count').notNull(),
    failCount: integer('fail_count').notNull(),
    noDataCount: integer('no_data_count').notNull(),
    p50LatencyMs: integer('p50_latency_ms'),
    closedAt: timestamp('closed_at').notNull(),
  },
  t => [
    primaryKey({ name: 'mocco_status_round_verdicts_pk', columns: [t.monitorId, t.roundAt] }),
    index('mocco_status_round_verdicts_workspace_round_idx').on(t.workspaceId, t.roundAt),
    check(
      'mocco_status_round_verdicts_verdict_check',
      sql`${t.verdict} IN (${sqlInList(Object.values(RoundVerdicts))})`,
    ),
  ],
);
