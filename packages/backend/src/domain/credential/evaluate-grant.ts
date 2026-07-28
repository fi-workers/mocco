/** A step's runtime credential request — the `{provider, role, ttl}` triple the
 * broker judges. Kept plain and self-contained (NOT derived from the config or DTO
 * schemas) so those can evolve independently of this pure invariant. */
export interface GrantRequest {
  provider: string;
  role: string;
  ttl: number;
}

/** The matched allowlist grant's authorizing fields — the ttl ceiling and the
 * provider/role it permits. `undefined` at the call site means no grant matched. */
export interface CredentialGrant {
  provider: string;
  role: string;
  maxTtlSeconds: number;
}

/** Why a request was denied — logged, never leaked to the caller (the broker returns
 * a fixed generic 403). SSOT for the reason strings (no magic strings). */
export const GrantDenials = {
  noGrant: 'no matching grant',
  providerMismatch: 'provider does not match grant',
  roleMismatch: 'role does not match grant',
  ttlExceedsMax: 'requested ttl exceeds grant max',
} as const;
export type GrantDenial = (typeof GrantDenials)[keyof typeof GrantDenials];

/** The evaluator's verdict — allow, or deny with a (loggable) reason. */
export type GrantDecision = { allowed: true } | { allowed: false; reason: GrantDenial };

/**
 * Judge a credential request against the grant that was matched for it (by the
 * repo/broker on `(repo, pipeline, gate)`). Pure, exhaustively unit-tested — the
 * SSOT for the allowlist authority check (slice-7 spec §6). Fail-closed: allowed
 * IFF a grant exists AND provider and role both match AND the requested ttl is
 * within the grant's ceiling; every other case denies.
 *
 * sonarjs/function-return-type is a false positive here: the return type is the
 * `GrantDecision` discriminated union declared above; each branch legitimately
 * returns a different member of that single union.
 */
// eslint-disable-next-line sonarjs/function-return-type
export function evaluateGrant(request: GrantRequest, grant: CredentialGrant | undefined): GrantDecision {
  if (grant === undefined) {
    return { allowed: false, reason: GrantDenials.noGrant };
  }
  if (request.provider !== grant.provider) {
    return { allowed: false, reason: GrantDenials.providerMismatch };
  }
  if (request.role !== grant.role) {
    return { allowed: false, reason: GrantDenials.roleMismatch };
  }
  if (request.ttl > grant.maxTtlSeconds) {
    return { allowed: false, reason: GrantDenials.ttlExceedsMax };
  }
  return { allowed: true };
}
