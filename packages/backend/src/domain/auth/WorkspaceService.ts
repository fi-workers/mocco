// Workspace service — cohesive business-logic unit, one file per service.
// Constructor injection (see AuthService.ts). Methods return the raw vendor rows;
// they are NOT parsed or re-typed here — the tRPC `.output()` schemas in the
// router are the egress filter and wire boundary (in-process consumers trusted).
import { randomUUID } from 'node:crypto';

import { WorkspaceNotFoundError } from '@backend/domain/auth/errors';
import { isAPIError } from '@backend/domain/auth/provider';

import type { Provider } from '@backend/domain/auth/provider';
import type { WorkspaceCreateInput } from '@mocco/common/workspace';

export class WorkspaceService {
  constructor(private readonly provider: Provider) {}

  /** Workspaces the current user belongs to. */
  async list(headers: Headers) {
    return await this.provider.api.listOrganizations({ headers });
  }

  /**
   * Create a workspace; the creator becomes its owner and it becomes session-active.
   *
   * The vendor's organization plugin requires a unique `slug`, but Mocco has no
   * product use for one (workspaces are addressed by uuid id, not a handle), so
   * we fill it with a fresh uuid behind this boundary. A v4 uuid never collides,
   * which is why there is no duplicate-slug error path — any vendor failure is
   * genuinely unexpected and propagates untouched.
   */
  async create(headers: Headers, input: WorkspaceCreateInput) {
    return await this.provider.api.createOrganization({
      body: { ...input, slug: randomUUID() },
      headers,
    });
  }

  /** Switch the session-active workspace (must be a member). */
  async setActive(headers: Headers, workspaceId: string): Promise<void> {
    await this.provider.api.setActiveOrganization({ body: { organizationId: workspaceId }, headers });
  }

  /** Rename a workspace (must have permission in it). */
  async update(headers: Headers, workspaceId: string, input: WorkspaceCreateInput) {
    let workspace;
    try {
      workspace = await this.provider.api.updateOrganization({
        body: { organizationId: workspaceId, data: input },
        headers,
      });
    } catch (error) {
      // The org plugin throws an APIError when the workspace is missing or isn't
      // the caller's — interpret that vendor failure as the domain error the
      // router maps to NOT_FOUND (a genuine internal error propagates untouched).
      if (isAPIError(error)) {
        throw new WorkspaceNotFoundError(workspaceId, { cause: error });
      }
      throw error;
    }
    // Defensive: the vendor's type admits null even though it throws in practice.
    if (!workspace) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return workspace;
  }

  /** Delete a workspace (owner only). */
  async delete(headers: Headers, workspaceId: string): Promise<void> {
    await this.provider.api.deleteOrganization({ body: { organizationId: workspaceId }, headers });
  }

  /** Members of a workspace (each with the joined user); the caller must belong to it. */
  async listMembers(headers: Headers, workspaceId: string) {
    try {
      const { members } = await this.provider.api.listMembers({ query: { organizationId: workspaceId }, headers });
      return members;
    } catch (error) {
      if (isAPIError(error)) {
        throw new WorkspaceNotFoundError(workspaceId, { cause: error });
      }
      throw error;
    }
  }

  /**
   * Assert the caller belongs to a workspace; throws WorkspaceNotFoundError (which
   * the router maps to NOT_FOUND) otherwise. The org plugin's listMembers already
   * authorizes membership — it throws for a non-member or a missing workspace — so
   * reusing it keeps this check on the same vendor-owned authority as every other
   * workspace operation, and the NOT_FOUND mapping avoids leaking the workspace's
   * existence to a non-member.
   */
  async assertMember(headers: Headers, workspaceId: string): Promise<void> {
    await this.listMembers(headers, workspaceId);
  }

  /**
   * The session-active workspace with members, or null when none is active.
   * Vendor contract (probe-verified): returns null when no workspace is active —
   * real errors (DB down etc.) propagate instead of masquerading as an empty state.
   */
  async getActive(headers: Headers) {
    return await this.provider.api.getFullOrganization({ headers });
  }
}
