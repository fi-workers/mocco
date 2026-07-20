import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  bigserial,
  jsonb,
  index,
  uniqueIndex,
  unique,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';

import type { Provider } from '@mocco/common/integration';

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
