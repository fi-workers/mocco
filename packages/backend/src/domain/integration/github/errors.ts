import { ForbiddenError } from '@backend/domain/errors';

/** A GitHub API call failed. Carries only a safe status/message — never the
 * octokit error object (which can hold the installation token in its request
 * headers). Interpreting is done here, at the vendor boundary. */
export class GithubApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status: number | undefined, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GithubApiError';
    this.status = status;
  }
}

/** Minting an installation access token came back 401/403 — GitHub's side has
 * uninstalled/suspended the app for this account. Distinct from a transient
 * GithubApiError: the caller should flip the connection to revoked rather than
 * retry. Carries only the status — never the octokit error object. */
export class ProviderConnectionRevokedError extends ForbiddenError {
  readonly status: number;

  constructor(status: number, options?: ErrorOptions) {
    super('GitHub installation access was revoked', options);
    this.name = 'ProviderConnectionRevokedError';
    this.status = status;
  }
}

/** A webhook payload failed schema validation for its declared event type.
 * Carries only the event type — never the zod issue list (which can echo
 * attacker-controlled payload fragments back into logs/responses). */
export class WebhookParseError extends Error {
  constructor(eventType: string, options?: ErrorOptions) {
    super(`GitHub webhook payload failed schema validation for event "${eventType}"`, options);
    this.name = 'WebhookParseError';
  }
}

/** Narrow an unknown thrown value to something with a numeric `status` (octokit RequestError shape). */
export function octokitStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}
