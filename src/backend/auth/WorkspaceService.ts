// Workspace service — cohesive business-logic unit, one file per service.
// Types come from @mocco/common zod schemas; returns are deliberately NOT
// parsed here (the tRPC .output() schemas are the egress filter — in-process
// consumers are trusted).
import type { Provider } from './provider';
import type { WorkspaceCreateInput, WorkspaceMemberRow, WorkspaceRow } from '@mocco/common/workspace';

export function createWorkspaceService(provider: Provider) {
  return {
    /** Workspaces the current user belongs to. */
    list: (headers: Headers): Promise<WorkspaceRow[]> => provider.api.listOrganizations({ headers }),

    /** Create a workspace; the creator becomes its owner and it becomes session-active. */
    create: async (headers: Headers, input: WorkspaceCreateInput): Promise<WorkspaceRow> => {
      const org = await provider.api.createOrganization({ body: input, headers });
      if (!org) {
        throw new Error('workspace creation returned nothing');
      }
      return org;
    },

    /** Switch the session-active workspace (must be a member). */
    setActive: async (headers: Headers, workspaceId: string): Promise<void> => {
      await provider.api.setActiveOrganization({ body: { organizationId: workspaceId }, headers });
    },

    /**
     * The session-active workspace with members, or null when none is active.
     * Vendor contract (probe-verified): returns null when no workspace is active —
     * real errors (DB down etc.) propagate instead of masquerading as an empty state.
     */
    getActive: (headers: Headers): Promise<(WorkspaceRow & { members: WorkspaceMemberRow[] }) | null> =>
      provider.api.getFullOrganization({ headers }),
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
