// Neutral auth surface — no vendor names leave this directory. A plain factory:
// production binds it to the app DB once (instance.ts); tests bind it to pglite.
// No test-only seams — both compose the same public function.
//
// Types come from @mocco/common zod schemas (the single type source). Each
// closure's explicit return annotation pins the neutral shape, so vendor type
// inference cannot leak. Returns are deliberately NOT parsed here: the tRPC
// .output() schemas are the egress filter (in-process consumers are trusted).
import { createProvider, type AdapterDb, type AuthOptions } from './provider';

import type { Session } from '@mocco/common/auth';
import type { WorkspaceCreateInput, WorkspaceMemberRow, WorkspaceRow } from '@mocco/common/workspace';

export function createAuthService(db: AdapterDb, options: AuthOptions = {}) {
  const provider = createProvider(db, options);
  return {
    /** Fetch-standard handler (Request → Response) for the auth routes. */
    handler: (request: Request): Promise<Response> => provider.handler(request),

    /** Read the current session from request headers (cookie-based). */
    getSession: (headers: Headers): Promise<Session | null> => provider.api.getSession({ headers }),

    /** Workspaces the current user belongs to. */
    listWorkspaces: (headers: Headers): Promise<WorkspaceRow[]> => provider.api.listOrganizations({ headers }),

    /** Create a workspace; the creator becomes its owner and it becomes session-active. */
    createWorkspace: async (headers: Headers, input: WorkspaceCreateInput): Promise<WorkspaceRow> => {
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
    getActiveWorkspace: (headers: Headers): Promise<(WorkspaceRow & { members: WorkspaceMemberRow[] }) | null> =>
      provider.api.getFullOrganization({ headers }),
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
