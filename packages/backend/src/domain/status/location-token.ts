// Probe location tokens: `mpl_` and 43 base64url characters (256 bits of randomness),
// stored only as a SHA-256 hex digest. One token authenticates one location.
import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'mpl_';

export function generateLocationToken(): string {
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Node 22 has no Uint8Array#toBase64
  return `${PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashLocationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
