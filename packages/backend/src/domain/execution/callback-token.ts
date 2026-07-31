import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The per-run callback token model — the single source of truth for hashing and
 * verifying the opaque token that authenticates a run's report-back. Shared by the
 * callback funnel (`RunService.applyCallback`) and the credential broker
 * (`CredentialBroker.issue`): both prove a caller holds the run's token by comparing
 * `sha-256(token)` against the run's stored `callbackTokenHash`. The plaintext is
 * minted once (threaded to the executor) and never persisted.
 */

/** The sha-256 hash (hex) of an opaque token — what we store; the plaintext is never persisted. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time compare of the token's hash against the stored hash — never a `===`
 * on secrets (that leaks length/prefix via timing). Length-guarded because
 * `timingSafeEqual` throws on unequal-length buffers. */
export function isTokenValid(token: string, storedHash: string): boolean {
  const provided = Buffer.from(hashToken(token), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return provided.length === stored.length && timingSafeEqual(provided, stored);
}
