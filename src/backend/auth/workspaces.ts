// Neutral workspace surface — no vendor names leave this directory.
// Wraps the vendor's organization API; consumed by the tRPC layer.
import { getProvider } from './provider';

/** Workspace shape exposed to the rest of the codebase. */
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: Date;
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  role: string;
  createdAt: Date;
}

function toWorkspace(org: {
  id: string;
  name: string;
  slug: string;
  // eslint-disable-next-line sonarjs/no-redundant-optional -- vendor type is `string | null | undefined`
  logo?: string | null;
  createdAt: Date;
}): Workspace {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    logo: org.logo ?? null,
    createdAt: org.createdAt,
  };
}

/** Workspaces the current user belongs to. */
export async function listWorkspaces(headers: Headers): Promise<Workspace[]> {
  const orgs = await getProvider().api.listOrganizations({ headers });
  return orgs.map(org => toWorkspace(org));
}

/** Create a workspace; the creator becomes its owner and it becomes session-active. */
export async function createWorkspace(headers: Headers, input: { name: string; slug: string }): Promise<Workspace> {
  const org = await getProvider().api.createOrganization({ body: input, headers });
  if (!org) {
    throw new Error('workspace creation returned nothing');
  }
  return toWorkspace(org);
}

/** Switch the session-active workspace (must be a member). */
export async function setActiveWorkspace(headers: Headers, workspaceId: string): Promise<void> {
  await getProvider().api.setActiveOrganization({ body: { organizationId: workspaceId }, headers });
}

/** The session-active workspace with members, or null when none is active. */
export async function getActiveWorkspace(
  headers: Headers,
): Promise<(Workspace & { members: WorkspaceMember[] }) | null> {
  // Vendor contract (probe-verified): returns null when no workspace is active —
  // real errors (DB down etc.) propagate instead of masquerading as an empty state.
  const full = await getProvider().api.getFullOrganization({ headers });
  if (!full) {
    return null;
  }
  return {
    ...toWorkspace(full),
    members: full.members.map(m => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      createdAt: m.createdAt,
    })),
  };
}
