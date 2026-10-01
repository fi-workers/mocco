// API key tokens: `<prefix><32 base62 chars>` (190 bits of randomness), stored as a
// SHA-256 hex digest. A token is recognised by its prefix before any lookup.
import { createHash, randomBytes } from 'node:crypto';

import { ApiKeyKinds, ApiKeyPrefixes } from '@mocco/common/apikey';

import type { ApiKeyKind } from '@mocco/common/apikey';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BODY_LENGTH = 32;
const TOKEN = /^mk_(pub|sec)_[0-9A-Za-z]{32}$/u;

/** A fresh token of `kind`. Rejection sampling keeps every character uniform. */
export function generateToken(kind: ApiKeyKind): string {
  const chars: string[] = [];
  while (chars.length < BODY_LENGTH) {
    const byte = randomBytes(1)[0] ?? 255;
    // 248 = 62 * 4: bytes at or above it would bias the first characters.
    if (byte < 248) {
      chars.push(ALPHABET[byte % ALPHABET.length] ?? '0');
    }
  }
  return `${ApiKeyPrefixes[kind]}${chars.join('')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The kind a token claims by its prefix, or null when it isn't shaped like a Mocco key. */
export function kindOfToken(token: string): ApiKeyKind | null {
  const match = TOKEN.exec(token);
  if (match === null) {
    return null;
  }
  return match[1] === 'pub' ? ApiKeyKinds.publishable : ApiKeyKinds.secret;
}
