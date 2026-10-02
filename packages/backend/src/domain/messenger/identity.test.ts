import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  isSessionToken,
  isUserHashValid,
  newIdentitySecret,
  newSessionToken,
  sessionTokenHash,
  userHashOf,
} from '@backend/domain/messenger/identity';

describe('messenger identity', () => {
  it('accepts exactly the hex HMAC-SHA256 of the user id', () => {
    const secret = newIdentitySecret();
    const hash = createHmac('sha256', secret).update('user-42').digest('hex');

    expect(userHashOf(secret, 'user-42')).toBe(hash);
    expect(isUserHashValid(secret, 'user-42', hash)).toBe(true);
    expect(isUserHashValid(secret, 'user-43', hash)).toBe(false);
    expect(isUserHashValid(newIdentitySecret(), 'user-42', hash)).toBe(false);
    expect(isUserHashValid(secret, 'user-42', hash.slice(0, 32))).toBe(false);
  });

  it('issues opaque session tokens and stores only their hash', () => {
    const first = newSessionToken();
    const second = newSessionToken();

    expect(isSessionToken(first.token)).toBe(true);
    expect(isSessionToken('mk_pub_abc')).toBe(false);
    expect(first.token).not.toBe(second.token);
    expect(first.hash).toBe(sessionTokenHash(first.token));
    expect(first.hash).not.toContain(first.token);
  });
});
