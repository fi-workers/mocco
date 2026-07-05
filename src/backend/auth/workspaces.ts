// Neutral workspace surface — no vendor names leave this directory.
// Vendor responses are parsed with zod at the boundary (parse, don't convert):
// unknown vendor fields are stripped, shape drift fails loudly here instead of
// leaking a wrong shape downstream.
import { z } from 'zod';

import { getProvider } from './provider';

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  // Vendor emits `string | null | undefined`; normalize to `string | null`.
  logo: z
    .string()
    .nullish()
    .transform(value => value ?? null),
  createdAt: z.date(),
});

const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  role: z.string(),
  createdAt: z.date(),
});

/** Workspace shape exposed to the rest of the codebase. */
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceMember = z.infer<typeof memberSchema>;

/** Workspaces the current user belongs to. */
export async function listWorkspaces(headers: Headers): Promise<Workspace[]> {
  const orgs = await getProvider().api.listOrganizations({ headers });
  return z.array(workspaceSchema).parse(orgs);
}

/** Create a workspace; the creator becomes its owner and it becomes session-active. */
export async function createWorkspace(headers: Headers, input: { name: string; slug: string }): Promise<Workspace> {
  const org = await getProvider().api.createOrganization({ body: input, headers });
  if (!org) {
    throw new Error('workspace creation returned nothing');
  }
  return workspaceSchema.parse(org);
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
  return workspaceSchema.extend({ members: z.array(memberSchema) }).parse(full);
}
