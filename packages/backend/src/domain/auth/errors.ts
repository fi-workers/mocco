// Auth-domain errors. The service (which owns the vendor boundary) throws these
// when it interprets a vendor failure; the tRPC layer maps them to transport
// codes via `instanceof` on the shared base — never by sniffing vendor error
// strings. Carry the vendor error as `cause` when there is one.
import { NotFoundError } from '@backend/domain/errors';

/** A workspace the caller referenced doesn't exist or isn't theirs to touch. */
export class WorkspaceNotFoundError extends NotFoundError {
  constructor(workspaceId: string, options?: ErrorOptions) {
    super(`Workspace ${workspaceId} was not found`, options);
    this.name = 'WorkspaceNotFoundError';
  }
}
