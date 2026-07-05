// Neutral auth surface — no vendor names leave this directory. A plain factory:
// production binds it to the app DB once (instance.ts); tests bind it to pglite.
// No test-only seams — both compose the same public function.
//
// The AuthService type is DERIVED from the factory (has-a, not is-a): each
// closure's explicit return annotation pins the neutral shape, so vendor type
// inference cannot leak through, without maintaining a parallel interface.
import { createProvider, type AdapterDb, type AuthOptions, type Provider } from './provider';

/** Session shape exposed to the rest of the codebase (vendor-inferred, neutrally named). */
export type Session = Provider['$Infer']['Session'];
export type AuthUser = Session['user'];

/**
 * Vendor-compatible workspace row, neutrally named. Deliberately NOT parsed
 * here: the tRPC output schemas are the egress filter that strips/normalizes
 * before anything crosses the wire (in-process consumers are trusted).
 */
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  // eslint-disable-next-line sonarjs/no-redundant-optional -- vendor type is `string | null | undefined`
  logo?: string | null;
  createdAt: Date;
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
}

export function createAuthService(db: AdapterDb, options: AuthOptions = {}) {
  const provider = createProvider(db, options);
  return {
    /** Fetch-standard handler (Request → Response) for the auth routes. */
    handler: (request: Request): Promise<Response> => provider.handler(request),

    /** Read the current session from request headers (cookie-based). */
    getSession: (headers: Headers): Promise<Session | null> => provider.api.getSession({ headers }),

    /** Workspaces the current user belongs to. */
    listWorkspaces: (headers: Headers): Promise<Workspace[]> => provider.api.listOrganizations({ headers }),

    /** Create a workspace; the creator becomes its owner and it becomes session-active. */
    createWorkspace: async (headers: Headers, input: { name: string; slug: string }): Promise<Workspace> => {
      const org = await provider.api.createOrganization({ body: input, headers });
      if (!org) {
        throw new Error('workspace creation returned nothing');
      }
      return org;
    },

    /** Switch the session-active workspace (must be a member). */
    setActiveWorkspace: async (headers: Headers, workspaceId: string): Promise<void> => {
      await provider.api.setActiveOrganization({ body: { organizationId: workspaceId }, headers });
    },

    /**
     * The session-active workspace with members, or null when none is active.
     * Vendor contract (probe-verified): returns null when no workspace is active —
     * real errors (DB down etc.) propagate instead of masquerading as an empty state.
     */
    getActiveWorkspace: (headers: Headers): Promise<(Workspace & { members: WorkspaceMember[] }) | null> =>
      provider.api.getFullOrganization({ headers }),
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
