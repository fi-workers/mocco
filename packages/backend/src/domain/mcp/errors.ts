// Errors the MCP tools map to messages a model can act on. They carry what the caller
// would need to fix the call, because a tool's error text is the only thing the model
// reads before deciding what to do next.
import { BadRequestError, ForbiddenError } from '@backend/domain/errors';

/** A workspace was named that the caller is not a member of. It says nothing about
 * whether that workspace exists — a non-member must not learn that from us. */
export class WorkspaceNotAllowedError extends ForbiddenError {
  constructor(workspaceId: string) {
    super(`No workspace ${workspaceId} is available to you`);
    this.name = 'WorkspaceNotAllowedError';
  }
}

const namesOf = (choices: readonly { id: string; name: string }[]) =>
  choices.map(each => `${each.name} (${each.id})`).join(', ');

/** No workspace was named and the caller is in none, or in more than one. Names the
 * choices, because that is the one thing an agent can act on without asking a human. */
export class WorkspaceUnclearError extends BadRequestError {
  constructor(readonly choices: readonly { id: string; name: string }[]) {
    super(
      choices.length === 0
        ? 'You are not a member of any workspace'
        : `Say which workspace with workspaceId: ${namesOf(choices)}`,
    );
    this.name = 'WorkspaceUnclearError';
  }
}

/** No project was named and the workspace has none, or more than one. Names the choices,
 * like `WorkspaceUnclearError`, so the agent can pick one without asking. */
export class ProjectUnclearError extends BadRequestError {
  constructor(readonly choices: readonly { id: string; name: string }[]) {
    super(
      choices.length === 0 ? 'This workspace has no projects' : `Say which project with projectId: ${namesOf(choices)}`,
    );
    this.name = 'ProjectUnclearError';
  }
}
