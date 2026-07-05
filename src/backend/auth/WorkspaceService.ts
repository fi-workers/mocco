// Workspace service — cohesive business-logic unit, one file per service.
// Constructor injection (see AuthService.ts). Types come from @mocco/common
// zod schemas; returns are deliberately NOT parsed here — the tRPC .output()
// schemas are the egress filter (in-process consumers are trusted).
import { SlugTakenError } from './errors';

import type { Provider } from './provider';
import type { WorkspaceCreateInput, WorkspaceMemberRow, WorkspaceRow } from '@mocco/common/workspace';

// Duplicate-slug rejections have two vendor-level sources (probe-verified):
// the vendor's exact-match pre-check (BAD_REQUEST "already exists"), and the
// DB's case-insensitive lower(slug) unique index (concurrent / case-variant
// races surface as a pg unique violation on error.cause).
const isDuplicateSlug = (error: unknown): boolean => {
  const { status } = error as { status?: string };
  const { message } = error as Error;
  const causeText = (error as { cause?: { message?: string } }).cause?.message;
  return (
    (status === 'BAD_REQUEST' && /already exists/i.test(message)) ||
    (causeText?.includes('mocco_workspaces_slug_lower_uq') ?? false)
  );
};

export class WorkspaceService {
  constructor(private readonly provider: Provider) {}

  /** Workspaces the current user belongs to. */
  async list(headers: Headers): Promise<WorkspaceRow[]> {
    return await this.provider.api.listOrganizations({ headers });
  }

  /**
   * Create a workspace; the creator becomes its owner and it becomes session-active.
   * @throws SlugTakenError when the slug is already in use; anything else re-throws untouched.
   */
  async create(headers: Headers, input: WorkspaceCreateInput): Promise<WorkspaceRow> {
    let org;
    try {
      org = await this.provider.api.createOrganization({ body: input, headers });
    } catch (error) {
      if (isDuplicateSlug(error)) {
        throw new SlugTakenError(input.slug, { cause: error });
      }
      throw error;
    }
    if (!org) {
      throw new Error('workspace creation returned nothing');
    }
    return org;
  }

  /** Switch the session-active workspace (must be a member). */
  async setActive(headers: Headers, workspaceId: string): Promise<void> {
    await this.provider.api.setActiveOrganization({ body: { organizationId: workspaceId }, headers });
  }

  /**
   * The session-active workspace with members, or null when none is active.
   * Vendor contract (probe-verified): returns null when no workspace is active —
   * real errors (DB down etc.) propagate instead of masquerading as an empty state.
   */
  async getActive(headers: Headers): Promise<(WorkspaceRow & { members: WorkspaceMemberRow[] }) | null> {
    return await this.provider.api.getFullOrganization({ headers });
  }
}
