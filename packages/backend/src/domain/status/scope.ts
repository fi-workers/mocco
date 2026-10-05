/** The tenant scope every status query runs in: a project of a workspace. */
export interface StatusScope {
  workspaceId: string;
  projectId: string;
}

/**
 * Who changes a project's status: a person in the console (their user id), or one of the
 * project's API keys (#159), which acts for the person who created it (null once they're
 * deleted), as other CI requests do. A key's changes are audited with that person as the actor
 * and `principal: "apikey:<id>"` in the payload, so the log tells the two apart.
 */
export type StatusActor = string | { userId: string | null; apiKeyId: string };

/** The actor's user id, and what an audit payload adds for a key. */
export function actorOf(actor: StatusActor): { userId: string | null; via: { principal?: string } } {
  return typeof actor === 'string'
    ? { userId: actor, via: {} }
    : { userId: actor.userId, via: { principal: `apikey:${actor.apiKeyId}` } };
}
