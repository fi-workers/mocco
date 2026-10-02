// The messenger's identity checks. A contact is whoever the app's server says: it signs
// the user id with the project's identity secret (hex HMAC-SHA256, `signIdentity` in
// @mocco/node), so a client can't claim someone else's id. Sessions are opaque tokens
// stored as SHA-256 hashes.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_PREFIX = 'mms_';
const GUEST_PREFIX = 'mmg_';

/** A new identity secret: 32 random bytes, hex. */
export const newIdentitySecret = (): string => randomBytes(32).toString('hex');

export const userHashOf = (secret: string, userId: string): string =>
  createHmac('sha256', secret).update(userId).digest('hex');

/** Whether `userHash` is `userId` signed with `secret`, in constant time. */
export function isUserHashValid(secret: string, userId: string, userHash: string): boolean {
  const expected = Buffer.from(userHashOf(secret, userId), 'hex');
  const given = Buffer.from(userHash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const sessionTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A new session token (`mms_` + 32 random bytes, base64url) and the hash to store. */
export function newSessionToken(): { token: string; hash: string } {
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 22 has no Uint8Array#toBase64
  const token = `${SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: sessionTokenHash(token) };
}

// eslint-disable-next-line sonarjs/null-dereference -- token is a string, never null
export const isSessionToken = (token: string): boolean => token.startsWith(SESSION_PREFIX);

/** The SecretBox AAD binding a sealed identity secret to its project. */
export const identitySecretAad = (projectId: string): string => `messenger-identity:${projectId}`;

/** A guest's device token (`mmg_` + 32 random bytes) and the hash to store. It finds the
 * same guest again on that device; it is the guest's only credential. */
export function newGuestToken(): { token: string; hash: string } {
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 22 has no Uint8Array#toBase64
  const token = `${GUEST_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, hash: sessionTokenHash(token) };
}
