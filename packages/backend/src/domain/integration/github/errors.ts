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

/** Narrow an unknown thrown value to something with a numeric `status` (octokit RequestError shape). */
export function octokitStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}
