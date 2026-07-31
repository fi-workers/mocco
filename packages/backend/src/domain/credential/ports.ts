/**
 * The credential-provider port (slice 7, PR2) — the neutral surface the broker
 * issues through once every fail-closed check has passed. The broker's decision
 * logic is provider-agnostic: the stub returns a clearly-fake credential now, and
 * the real AWS OIDC STS provider is a later, user-side swap behind this same port.
 */

/** The authorized issue request the broker hands the provider — already validated
 * against the workspace allowlist (provider/role permitted, ttl within the ceiling). */
export interface CredentialIssueRequest {
  provider: string;
  role: string;
  ttlSeconds: number;
}

/** A minted credential — a small typed shape the broker returns to the caller on
 * ALLOW. `value` is the opaque secret (a real STS session token later; a fixed
 * fake now). `expiresAt` reflects the requested ttl. */
export interface IssuedCredentials {
  provider: string;
  role: string;
  expiresAt: Date;
  value: string;
}

/** Issues cloud credentials for an already-authorized request. The only vendor seam
 * — everything above it (the broker) is provider-agnostic. */
export interface CredentialProvider {
  issue(request: CredentialIssueRequest): Promise<IssuedCredentials>;
}
