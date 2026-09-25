import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretBoxError } from '@backend/infra/crypto/errors';
import { createSecretBox } from '@backend/infra/crypto/instance';

// eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Buffer is the available codec (see secret-box.ts).
const randomKey = (): string => randomBytes(32).toString('base64');

describe('createSecretBox', () => {
  it('fails loudly, naming the env var, only when a sealing feature asks for it', () => {
    expect(() => createSecretBox(undefined)).toThrow(/SECRETS_ENCRYPTION_KEYS/);
    expect(() => createSecretBox(undefined)).toThrow(SecretBoxError);
  });

  it('builds a working box from the env string', () => {
    const box = createSecretBox(`k1:${randomKey()}`);
    expect(box.open(box.seal('x', 't:1'), 't:1')).toBe('x');
  });
});
