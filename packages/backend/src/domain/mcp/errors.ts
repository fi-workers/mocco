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

/** No app was named and the project has none of the kind the tool reads, or more than
 * one. Names the choices, like `ProjectUnclearError`. `kind` says which apps count, e.g.
 * `hosted OTA app` or `iOS or Android app`. */
export class AppUnclearError extends BadRequestError {
  constructor(
    kind: string,
    readonly choices: readonly { id: string; name: string }[],
  ) {
    super(choices.length === 0 ? `This project has no ${kind}` : `Say which app with appId: ${namesOf(choices)}`);
    this.name = 'AppUnclearError';
  }
}

/** No status page was named and the project has none, or more than one. Names the
 * choices, like `ProjectUnclearError`. */
export class StatusPageUnclearError extends BadRequestError {
  constructor(readonly choices: readonly { id: string; name: string }[]) {
    super(
      choices.length === 0
        ? 'This project has no status pages'
        : `Say which status page with pageId: ${namesOf(choices)}`,
    );
    this.name = 'StatusPageUnclearError';
  }
}

/** No Discord server was named and the workspace has the bot in none, or in more than
 * one. Names the choices, like `ProjectUnclearError`. */
export class DiscordServerUnclearError extends BadRequestError {
  constructor(readonly choices: readonly { id: string; name: string }[]) {
    super(
      choices.length === 0
        ? 'No Discord server is connected to this workspace: an owner or admin adds the Mocco bot in the console, under Notifications'
        : `Say which Discord server with guildId: ${namesOf(choices)}`,
    );
    this.name = 'DiscordServerUnclearError';
  }
}

/** A tool's service is not composed on this server (inbound webhooks need
 * `SECRETS_ENCRYPTION_KEYS`). Says what is missing, so the agent stops retrying and can
 * tell whoever runs Mocco what to set. */
export class ToolUnavailableError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'ToolUnavailableError';
  }
}

/** A cursor the tool did not hand out, or one that was changed on the way back. */
export class InvalidCursorError extends BadRequestError {
  constructor(options?: ErrorOptions) {
    super(
      "That cursor is not one this tool returned: pass the previous answer's `nextCursor` as it was given",
      options,
    );
    this.name = 'InvalidCursorError';
  }
}
