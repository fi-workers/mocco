// Which workspace a tool call acts in.
//
// A person can belong to several and an agent has no way to know which one is meant.
// Asking on every call is noise; guessing is worse. So: when the caller belongs to
// exactly one workspace that is the answer and nothing has to be said, and otherwise the
// refusal names the choices — the one thing the agent can act on by itself.
//
// Every resolution re-checks membership, so a workspace id appearing in a tool call
// grants nothing on its own: it only selects among what the caller already has.
import { WorkspaceNotAllowedError, WorkspaceUnclearError } from '@backend/domain/mcp/errors';

import type { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';

export interface WorkspaceScopeDeps {
  memberships: Pick<MembershipRepo, 'listForUser' | 'isMember'>;
}

export class WorkspaceScope {
  constructor(private readonly deps: WorkspaceScopeDeps) {}

  /**
   * The workspace this call acts in: the one asked for when the caller is in it, else the
   * caller's only one. Throws `WorkspaceUnclearError` naming the choices when neither.
   */
  async resolve(userId: string, asked?: string): Promise<string> {
    if (asked !== undefined) {
      if (!(await this.deps.memberships.isMember(userId, asked))) {
        throw new WorkspaceNotAllowedError(asked);
      }
      return asked;
    }
    const mine = await this.deps.memberships.listForUser(userId);
    const [only] = mine;
    if (mine.length !== 1 || only === undefined) {
      throw new WorkspaceUnclearError(mine.map(each => ({ id: each.workspaceId, name: each.name })));
    }
    return only.workspaceId;
  }

  /** The caller's workspaces, for the tool that lets an agent discover them. */
  async list(userId: string) {
    return await this.deps.memberships.listForUser(userId);
  }
}
