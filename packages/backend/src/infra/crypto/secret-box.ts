// SecretBox — authenticated encryption for third-party secrets at rest (platform
// foundations §3.0). AES-256-GCM with a fresh 12-byte IV per seal; the AAD binds a
// sealed value to its row ('<table>:<id>'), so a value copied into another row fails
// to open. Envelope: v1.<keyId>.<iv>.<ciphertext>.<tag> (base64url parts). The first
// key seals, every key opens — rotation = prepend a key, reseal, drop the old one.
// Errors never carry plaintext, key material or the sealed string.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { SecretBoxError } from '@backend/infra/crypto/errors';

export interface SecretKey {
  id: string;
  key: Buffer;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID = /^[\w-]{1,32}$/;
// v1.<keyId>.<iv>.<ciphertext>.<tag> — the ciphertext is empty for an empty plaintext.
const ENVELOPE = /^v1\.([\w-]{1,32})\.([\w-]+)\.([\w-]*)\.([\w-]+)$/;
const KEY_ENTRY = /^([^:]+):(.+)$/;

// Uint8Array.fromBase64/toBase64 are still behind a V8 flag on the Node runtime this
// targets (same reason as infra/config/env.ts) — Buffer is the available codec.
const encode = (bytes: Buffer): string =>
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  bytes.toString('base64url');
const decode = (text: string, encoding: 'base64' | 'base64url'): Buffer => Buffer.from(text, encoding);

export class SecretBox {
  private readonly current: SecretKey;

  private readonly byId: ReadonlyMap<string, Buffer>;

  constructor(keys: readonly SecretKey[]) {
    const [first] = keys;
    if (first === undefined) {
      throw new SecretBoxError('SecretBox needs at least one key');
    }
    const wrongLength = keys.find(({ key }) => key.length !== KEY_BYTES);
    if (wrongLength !== undefined) {
      throw new SecretBoxError(`key "${wrongLength.id}" must be ${KEY_BYTES} bytes`);
    }
    const ids = keys.map(({ id }) => id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate !== undefined) {
      throw new SecretBoxError(`duplicate key id "${duplicate}"`);
    }
    this.byId = new Map(keys.map(({ id, key }) => [id, key]));
    this.current = first;
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.current.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', this.current.id, encode(iv), encode(ciphertext), encode(cipher.getAuthTag())].join('.');
  }

  open(sealed: string, aad: string): string {
    const match = ENVELOPE.exec(sealed);
    if (match === null) {
      throw new SecretBoxError('sealed value is malformed');
    }
    const [, keyId = '', ivPart = '', ciphertextPart = '', tagPart = ''] = match;
    const key = this.byId.get(keyId);
    if (key === undefined) {
      throw new SecretBoxError(`unknown key id "${keyId}"`);
    }
    const iv = decode(ivPart, 'base64url');
    const tag = decode(tagPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError('sealed value is malformed');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(decode(ciphertextPart, 'base64url')), decipher.final()]).toString('utf8');
    } catch (error) {
      // Wrong key, wrong AAD, or tampered bytes — GCM authentication failed.
      throw new SecretBoxError('sealed value failed authentication', { cause: error });
    }
  }

  /** True when `sealed` was made with a key other than the current sealing key. */
  needsReseal(sealed: string): boolean {
    return ENVELOPE.exec(sealed)?.[1] !== this.current.id;
  }
}

/** Parse `SECRETS_ENCRYPTION_KEYS` (`keyId:base64key,…`, first key seals). Messages
 * name the key id, never the key. */
export function parseSecretKeys(raw: string): SecretKey[] {
  // sonarjs/null-dereference is a false positive: `raw` is a non-optional string.
  // eslint-disable-next-line sonarjs/null-dereference
  const entries = raw
    .split(',')
    // sonarjs/null-dereference is a false positive: split() yields strings only.
    // eslint-disable-next-line sonarjs/null-dereference
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
  if (entries.length === 0) {
    throw new SecretBoxError('SECRETS_ENCRYPTION_KEYS has no keys');
  }
  return entries.map((entry, index) => {
    const match = KEY_ENTRY.exec(entry);
    const [, id = '', encoded = ''] = match ?? [];
    if (match === null) {
      throw new SecretBoxError(`SECRETS_ENCRYPTION_KEYS entry ${index + 1} must be keyId:base64key`);
    }
    if (!KEY_ID.test(id)) {
      throw new SecretBoxError(`SECRETS_ENCRYPTION_KEYS entry ${index + 1} has an invalid key id`);
    }
    const key = decode(encoded, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new SecretBoxError(`key "${id}" must be ${KEY_BYTES} bytes (openssl rand -base64 32)`);
    }
    return { id, key };
  });
}
