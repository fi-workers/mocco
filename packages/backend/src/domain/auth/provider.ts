// The ONLY file that imports the auth vendor. Everything else consumes the
// neutral surface (./service.ts), so the vendor can be swapped by rewriting
// this file alone (plus the client wrapper on the frontend).
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { McpScopes, mcpSignInScopes } from '@mocco/common/mcp';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { toNodeHandler } from 'better-auth/node';
import { jwt, organization } from 'better-auth/plugins';

import {
  accounts,
  invitations,
  jwks,
  members,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  sessions,
  users,
  verifications,
  workspaces,
} from '@backend/infra/db/schema';

// Re-exported so the domain services can interpret vendor failures (the org
// plugin throws this on missing/forbidden operations) without importing the
// vendor themselves — this file stays the only vendor importer.
export { isAPIError } from 'better-auth/api';

export interface AuthOptions {
  /** Session signing secret. */
  secret?: string;
  /** Public base URL of the app. */
  baseUrl?: string;
  /** Origins allowed to call the auth endpoints (origin/CSRF check). */
  trustedOrigins?: string[];
  /**
   * The MCP protected resource identifier (`mcpResourceOf`) — the canonical URL this
   * server is known by. Issued tokens are audience-bound to it and it is published in the
   * RFC 9728 metadata, so a token minted for another MCP server cannot be replayed here.
   * Required: it has no safe default (see `createProvider`).
   */
  mcpResource: string;
}

/** Where a client is sent to sign in, and to approve what it is asking for. */
const LOGIN_PAGE = '/auth/sign-in';
const CONSENT_PAGE = '/auth/consent';

/**
 * Every scope the authorization server can grant: the vendor's sign-in defaults plus
 * `approvals:write` and `status:write`. A registered client's capability set is this list
 * (the vendor persists it at registration), so a client can later step up to either
 * without registering again. Clients stored before the scope existed lack it until their
 * Client ID Metadata Document is fetched again — the vendor re-persists the client on
 * every metadata refresh, which a fresh server process always does on first use.
 */
const MCP_SCOPES = [...mcpSignInScopes, McpScopes.approvalsWrite, McpScopes.statusWrite];

/**
 * Notes on the MCP plugins, registered by `createMcpProvider` below.
 *
 * `mcp()` is the OAuth 2.1 provider configured for MCP — it audience-binds issued tokens
 * to `resource` and serves the RFC 9728 protected-resource metadata, so `oauthProvider()`
 * is deliberately not registered alongside it. `cimd()` provides the Client ID Metadata
 * Document flow that the 2026-07-28 revision pins in place of Dynamic Client
 * Registration. `jwt()` publishes the JWKS that `requireMcpAuth` verifies tokens against.
 *
 * `fetchClientMetadataResource` comes from the vendor's Node build on purpose. Fetching a
 * client's metadata document is an SSRF surface, and the contract is specific: resolve
 * DNS once, reject RFC 6890 special-use addresses, pin the resolved address for the
 * connection, never follow a redirect. The vendor's own note says that cannot be built by
 * wrapping `fetch` after resolution — so we do not try.
 */

/** Any drizzle database the adapter accepts (node-postgres in prod, pglite in tests). */
export type AdapterDb = Parameters<typeof drizzleAdapter>[0];

/** Everything both providers share. Split out so each `betterAuth` call below keeps a
 * concrete `plugins` tuple: a conditional array widens it, and the vendor's inference
 * then loses the typed `api` the services rely on. */
function baseOptions(db: AdapterDb, options: AuthOptions) {
  return {
    // Explicit injection only — the vendor's own env auto-detection is not relied upon.
    ...(options.secret && { secret: options.secret }),
    ...(options.baseUrl && { baseURL: options.baseUrl }),
    ...(options.trustedOrigins?.length && { trustedOrigins: options.trustedOrigins }),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        organization: workspaces,
        member: members,
        invitation: invitations,
        // The OAuth 2.1 authorization server's own models (ADR 0025). The adapter maps
        // by model name, so every one a registered plugin declares has to appear here —
        // a missing entry fails at adapter start with "model X was not found in the
        // schema object", not at the request that would have used it.
        jwks,
        oauthClient: oauthClients,
        oauthResource: oauthResources,
        oauthClientResource: oauthClientResources,
        oauthRefreshToken: oauthRefreshTokens,
        oauthAccessToken: oauthAccessTokens,
        oauthConsent: oauthConsents,
        oauthClientAssertion: oauthClientAssertions,
      },
    }),
    // Start with email+password only. Verification emails come later (SMTP);
    // social providers (Google) land as separate PRs.
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    advanced: {
      // uuid PKs are generated by the DB (defaultRandom) — Mocco convention (non-sequential).
      database: { generateId: false },
    },
  } as const;
}

/**
 * Factory — lets tests run the full auth stack against an isolated (pglite) DB.
 *
 * Workspace = organization plugin (members, roles). The invitation MODEL is mapped for
 * plugin compatibility; the invite FLOW ships later. Teams/dynamic roles come later. The
 * plugin requires a unique slug; WorkspaceService fills it with a system uuid, so no
 * create-time slug hook is needed.
 *
 * The MCP plugins are always registered rather than switched on, because a plugin list
 * that varies is a type that varies: the vendor encodes the tuple in the provider's
 * type, so a conditional array widens it and the typed `api` the services rely on
 * collapses to `any`. One shape, always.
 *
 * That is why `mcpResource` is required. It is baked into every issued token and into
 * published metadata, so there is no sensible default to fall back to — the caller has
 * to say where this server lives, and the compiler makes them.
 */
export function createProvider(db: AdapterDb, options: AuthOptions) {
  return betterAuth({
    ...baseOptions(db, options),
    plugins: [
      organization(),
      jwt(),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
      mcp({
        resource: options.mcpResource,
        loginPage: LOGIN_PAGE,
        consentPage: CONSENT_PAGE,
        scopes: MCP_SCOPES,
      }),
    ],
  });
}

export type Provider = ReturnType<typeof createProvider>;

/** Node-style (req, res) handler for the auth routes — for Pages Router API
 * routes, which are Node handlers rather than Web-standard. The vendor's own
 * bridge (tested cookie/body/stream handling) stays behind this boundary. */
export function toNodeAuthHandler(provider: Provider) {
  return toNodeHandler(provider);
}
export type NodeAuthHandler = ReturnType<typeof toNodeAuthHandler>;
