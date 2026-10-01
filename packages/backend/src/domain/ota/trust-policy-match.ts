// Matching an OIDC token's claims against trust policies. Pure.
import type { GitHubOidcClaims } from '@backend/domain/integration/github/oidc';
import type { TrustPolicyRow } from '@backend/domain/ota/repos/trust-policy.repo';

/**
 * Whether `ref` matches `pattern`, where `*` stands for any run of characters
 * (`refs/tags/v*`). Without a `*` it must be equal. No regex: the pattern is user input.
 * (sonarjs/null-dereference is a false positive on these strings, so it is off here.)
 */
/* eslint-disable sonarjs/null-dereference */
export function isRefMatch(pattern: string, ref: string): boolean {
  const pieces = pattern.split('*');
  if (pieces.length === 1) {
    return pattern === ref;
  }
  const first = pieces[0] ?? '';
  const last = pieces.at(-1) ?? '';
  if (!ref.startsWith(first) || !ref.endsWith(last) || ref.length < first.length + last.length) {
    return false;
  }
  const middle = ref.slice(first.length, ref.length - last.length);
  // Each inner piece must appear in order inside the middle.
  const position = pieces.slice(1, -1).reduce<number | null>((from, piece) => {
    if (from === null) {
      return null;
    }
    const found = middle.indexOf(piece, from);
    return found === -1 ? null : found + piece.length;
  }, 0);
  return position !== null;
}
/* eslint-enable sonarjs/null-dereference */

/** The first policy (oldest) the claims satisfy, or undefined. The repository id is
 * matched by the query; this checks ref, workflow and environment. */
export function matchingPolicy(
  policies: readonly TrustPolicyRow[],
  claims: GitHubOidcClaims,
): TrustPolicyRow | undefined {
  return policies.find(
    policy =>
      policy.repositoryId === BigInt(claims.repository_id) &&
      isRefMatch(policy.refPattern, claims.ref) &&
      (policy.workflowRef === null || policy.workflowRef === claims.job_workflow_ref) &&
      (policy.environment === null || policy.environment === claims.environment),
  );
}
