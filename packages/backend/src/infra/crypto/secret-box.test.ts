import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretBoxError } from '@backend/infra/crypto/errors';
import { SecretBox, parseSecretKeys } from '@backend/infra/crypto/secret-box';

const keyA = { id: 'a', key: randomBytes(32) };
const keyB = { id: 'b', key: randomBytes(32) };
const AAD = 'mocco_inbound_sources:11111111-1111-1111-1111-111111111111';

// eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Buffer is the available codec (see secret-box.ts).
const randomKeyB64 = (bytes = 32): string => randomBytes(bytes).toString('base64');
// Replace the first character so the part still decodes but its bytes change.
const flip = (part = ''): string =>
  // sonarjs/null-dereference is a false positive: `part` defaults to a string.
  // eslint-disable-next-line sonarjs/null-dereference
  part.startsWith('A') ? `B${part.slice(1)}` : `A${part.slice(1)}`;

describe('SecretBox', () => {
  it.each(['whsec_abc', '', '비밀 🔐 値'])('round-trips %j byte-exactly', plaintext => {
    const box = new SecretBox([keyA]);
    expect(box.open(box.seal(plaintext, AAD), AAD)).toBe(plaintext);
  });

  it('produces the v1.<keyId>.<iv>.<ct>.<tag> envelope with a fresh iv each time', () => {
    const box = new SecretBox([keyA]);
    const first = box.seal('same', AAD);
    const second = box.seal('same', AAD);
    expect(first.split('.')).toHaveLength(5);
    expect(first.startsWith('v1.a.')).toBe(true);
    expect(first).not.toBe(second);
  });

  it('refuses to open under a different aad (a value copied to another row)', () => {
    const box = new SecretBox([keyA]);
    const sealed = box.seal('secret', AAD);
    expect(() => box.open(sealed, 'mocco_inbound_sources:other')).toThrow(SecretBoxError);
  });

  it('refuses a tampered tag or ciphertext', () => {
    const box = new SecretBox([keyA]);
    const [v, id, iv, ct, tag] = box.seal('secret', AAD).split('.');
    expect(() => box.open([v, id, iv, ct, flip(tag)].join('.'), AAD)).toThrow(SecretBoxError);
    expect(() => box.open([v, id, iv, flip(ct), tag].join('.'), AAD)).toThrow(SecretBoxError);
  });

  it.each(['', 'v1.a.x', 'v2.a.aa.bb.cc', 'v1.a.!!.@@.##', 'not-a-sealed-value', 'v1.a.AAAA.AAAA.AAAA'])(
    'rejects malformed envelope %j with SecretBoxError',
    bad => {
      expect(() => new SecretBox([keyA]).open(bad, AAD)).toThrow(SecretBoxError);
    },
  );

  it('opens values sealed with an older key after rotation, and reports reseal', () => {
    const sealedWithA = new SecretBox([keyA]).seal('secret', AAD);
    const rotated = new SecretBox([keyB, keyA]);
    expect(rotated.open(sealedWithA, AAD)).toBe('secret');
    expect(rotated.needsReseal(sealedWithA)).toBe(true);
    expect(rotated.needsReseal(rotated.seal('secret', AAD))).toBe(false);
  });

  it('names the unknown key id once the old key is dropped, never the key material', () => {
    const sealedWithA = new SecretBox([keyA]).seal('secret', AAD);
    expect(() => new SecretBox([keyB]).open(sealedWithA, AAD)).toThrow(/unknown key id "a"/);
  });

  it('rejects key ids the envelope cannot carry', () => {
    expect(() => new SecretBox([{ id: 'a.b', key: randomBytes(32) }])).toThrow(SecretBoxError);
    expect(() => new SecretBox([{ id: 'x'.repeat(33), key: randomBytes(32) }])).toThrow(SecretBoxError);
  });

  it('refuses a tampered iv and non-canonical base64url parts', () => {
    const box = new SecretBox([keyA]);
    const [v, id, iv = '', ct, tag = ''] = box.seal('secret', AAD).split('.');
    expect(() => box.open([v, id, flip(iv), ct, tag].join('.'), AAD)).toThrow(SecretBoxError);
    // A 16-byte tag encodes to 22 chars whose last carries 4 unused bits; setting one
    // keeps the decoded bytes but changes the string.
    const last = tag.at(-1) ?? 'A';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const bumped = alphabet[alphabet.indexOf(last) + 1] ?? 'A';
    expect(() => box.open([v, id, iv, ct, `${tag.slice(0, -1)}${bumped}`].join('.'), AAD)).toThrow(SecretBoxError);
  });

  it('seals and opens with an empty aad', () => {
    const box = new SecretBox([keyA]);
    expect(box.open(box.seal('x', ''), '')).toBe('x');
  });

  it('reports malformed values as not needing reseal', () => {
    expect(new SecretBox([keyA]).needsReseal('garbage')).toBe(false);
  });

  it('names itself in logs', () => {
    expect(String(new SecretBoxError('m'))).toBe('SecretBoxError: m');
  });

  it('requires at least one 32-byte key with unique ids', () => {
    expect(() => new SecretBox([])).toThrow(SecretBoxError);
    expect(() => new SecretBox([{ id: 'short', key: randomBytes(16) }])).toThrow(/"short"/);
    expect(() => new SecretBox([keyA, { id: 'a', key: randomBytes(32) }])).toThrow(/duplicate key id "a"/);
  });

  it('never puts plaintext or sealed text in error messages', () => {
    const box = new SecretBox([keyA]);
    const sealed = box.seal('super-secret-value', AAD);
    const error: unknown = (() => {
      try {
        return box.open(sealed, 'wrong');
      } catch (error_) {
        return error_;
      }
    })();
    expect(error).toBeInstanceOf(SecretBoxError);
    expect(String(error)).not.toContain('super-secret-value');
    expect(String(error)).not.toContain(sealed);
  });
});

describe('parseSecretKeys', () => {
  it('parses a comma list, trimming whitespace and ignoring empty entries', () => {
    const keys = parseSecretKeys(` k2:${randomKeyB64()} , k1:${randomKeyB64()},`);
    expect(keys.map(k => k.id)).toEqual(['k2', 'k1']);
    expect(keys.every(k => k.key.length === 32)).toBe(true);
  });

  it('rejects entries without a colon, bad ids and wrong-length keys by id only', () => {
    expect(() => parseSecretKeys('nocolon')).toThrow(SecretBoxError);
    expect(() => parseSecretKeys(`bad id:${randomKeyB64()}`)).toThrow(SecretBoxError);
    const short = randomKeyB64(8);
    expect(() => parseSecretKeys(`k1:${short}`)).toThrow(/"k1"/);
    expect(() => parseSecretKeys(`k1:${short}`)).not.toThrow(short);
  });

  it('rejects a key with stray characters Buffer would silently skip', () => {
    const encoded = randomKeyB64();
    expect(() => parseSecretKeys(`k1:${encoded.slice(0, 20)}!!!!${encoded.slice(20)}`)).toThrow(/"k1"/);
  });

  it('rejects an empty list', () => {
    expect(() => parseSecretKeys(' , ')).toThrow(SecretBoxError);
  });
});
