import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex, check } from 'drizzle-orm/pg-core';

// Table prefix: mocco_. Better Auth tables must also use the mocco_ prefix.
// id: uuid (non-sequential — safe for token/audit/URL exposure).

// Shared column helpers
const createdAt = timestamp('created_at').notNull().defaultNow();
const updatedAt = timestamp('updated_at')
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());

// ─────────────────────────────────────────────────────────────
// Better Auth (GitHub OAuth login). uuid PK — with betterAuth advanced.database.generateId=false,
// ids are generated in the DB (defaultRandom). drizzle keys are camelCase (adapter mapping); columns are snake_case.
// ─────────────────────────────────────────────────────────────

/** Logged-in user (GitHub identity). */
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
export const workspaces = pgTable(
  'mocco_workspaces',
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    // uniqueness is the case-insensitive index below (subsumes exact uniqueness)
    slug: text().notNull(),
    logo: text(),
    metadata: text(),
    createdAt,
  },
  table => [
    // The vendor's duplicate-slug pre-check is exact-match only; this closes the
    // case-variant hole ('acme-lab' vs 'Acme-Lab') at the DB.
    uniqueIndex('mocco_workspaces_slug_lower_uq').on(sql`lower(${table.slug})`),
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
    // MVP role set; widen via migration when dynamic roles land.
    check('mocco_members_role_check', sql`${table.role} in ('owner', 'admin', 'member')`),
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
  table => [index('mocco_sessions_user_id_idx').on(table.userId)],
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
