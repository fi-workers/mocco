// Auth-domain errors. The service (which owns the vendor boundary) throws these
// when it interprets a vendor failure; the tRPC layer maps them to transport
// codes via `instanceof` on the shared base — never by sniffing vendor error
// strings. Carry the vendor error as `cause` when there is one.
import { ForbiddenError, NotFoundError } from '@backend/domain/errors';

/** A workspace the caller referenced doesn't exist or isn't theirs to touch. */
export class WorkspaceNotFoundError extends NotFoundError {
  constructor(workspaceId: string, options?: ErrorOptions) {
    super(`Workspace ${workspaceId} was not found`, options);
    this.name = 'WorkspaceNotFoundError';
  }
}

/** The caller is a member of the workspace but not an owner or admin, which the
 * operation requires. */
export class WorkspaceAdminRequiredError extends ForbiddenError {
  constructor(workspaceId: string, options?: ErrorOptions) {
    super(`Only an owner or admin of workspace ${workspaceId} can do this`, options);
    this.name = 'WorkspaceAdminRequiredError';
  }
}
