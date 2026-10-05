// Heartbeat ping tokens (#153): `mhb_` and 43 base64url characters (256 bits of randomness).
// The token is the credential of the ping routes, so it is returned once, when the monitor is
// created or its token rotated, and stored only as a SHA-256 hex digest.
import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'mhb_';

export function generateHeartbeatToken(): string {
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 22 has no Uint8Array#toBase64
  return `${PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashHeartbeatToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
