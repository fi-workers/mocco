// Workspace service — cohesive business-logic unit, one file per service.
// Constructor injection (see AuthService.ts). Methods return the raw vendor rows;
// they are NOT parsed or re-typed here — the tRPC `.output()` schemas in the
// router are the egress filter and wire boundary (in-process consumers trusted).
import { randomUUID } from 'node:crypto';

import type { Provider } from './provider';
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
    const org = await this.provider.api.createOrganization({
      body: { ...input, slug: randomUUID() },
      headers,
    });
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
  async getActive(headers: Headers) {
    return await this.provider.api.getFullOrganization({ headers });
  }
}
