import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';

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
