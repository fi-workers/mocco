---
title: SecretBox (encrypted third-party secrets at rest) implementation plan
description: Plan for issue #110 — infra/crypto/secret-box.ts (AES-256-GCM, keyId-prefixed envelopes, AAD bound to the row), the SECRETS_ENCRYPTION_KEYS env var with rotation, a lazy composition root that fails only when sealing is used, and the *_sealed / hasSecret conventions.
type: spec
status: active
created: 2026-09-25
updated: 2026-09-25
confidence: high
owner: andrea
tags: [spec, plan, platform, crypto, secrets]
related:
  - ../../specs/2026-09-24-platform-foundations-design.md
---

# SecretBox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One audited way to store vendor secrets at rest: `seal(plaintext, aad)` / `open(sealed, aad)` with AES-256-GCM, rotatable keys, and conventions that keep sealed values out of every API output.

**Architecture:** A pure class `SecretBox` in `packages/backend/src/infra/crypto/secret-box.ts` constructed with an explicit key list (constructor injection, no env inside). `parseSecretKeys` turns the env string into that list. A lazy composition root `infra/crypto/instance.ts` builds the production instance from `getEnv().SECRETS_ENCRYPTION_KEYS` and throws only when first called without it.

**Tech Stack:** `node:crypto` (`createCipheriv`/`createDecipheriv`, `aes-256-gcm`, `randomBytes`), zod (env), vitest.

**Spec:** `docs/specs/2026-09-24-platform-foundations-design.md` §3.0, consumed by `docs/superpowers/specs/2026-09-25-notification-relay-design.md` §5. Issue #110. One PR, branch `feat/secret-box` off `origin/main`.

## Global Constraints

- Envelope: `v1.<keyId>.<iv>.<ciphertext>.<tag>`, each binary part base64url, `.`-joined. IV 12 bytes, tag 16 bytes, key 32 bytes.
- `aad` binds a value to its row: callers pass `'<table>:<id>'` (e.g. `'mocco_inbound_sources:6f1…'`).
- Env: `SECRETS_ENCRYPTION_KEYS` = comma-separated `keyId:base64key`; the **first** key seals, **all** keys open. `keyId` matches `^[A-Za-z0-9_-]{1,32}$`.
- Missing env must not fail at boot or build — only when `getSecretBox()` is first called.
- Columns holding sealed values are named `*_sealed` and never appear in a zod `.output()`; services project `hasSecret: boolean`.
- No new dependency. English only. Absolute `@backend/*` imports. No `enum`. Braces on every control statement.
- Errors never include plaintext, key material or the sealed string.

## Review Focus

1. Empty-string and multi-byte (Korean, emoji) plaintext must round-trip byte-exactly → test in Task 1.
2. A sealed value with a wrong part count, unknown version, or non-base64url garbage must throw `SecretBoxError`, not a raw Node error or a `TypeError` → test in Task 1.
3. Env strings with whitespace around entries (`"a:xxx, b:yyy"`), a trailing comma, duplicate key ids, or a key that decodes to ≠32 bytes → trimmed/accepted or rejected with a message naming the key id (never the key) → tests in Task 2.
4. Rotation: value sealed under `a`, then env becomes `b,a` → opens, and `needsReseal` reports `true`; after dropping `a` it throws `SecretBoxError` naming the unknown key id → test in Task 1.
5. Two seals of the same plaintext differ (fresh IV each time) → test in Task 1.

---

## File Structure

- Create `packages/backend/src/infra/crypto/secret-box.ts` — `SecretBox`, `parseSecretKeys`, `SecretKey` type.
- Create `packages/backend/src/infra/crypto/errors.ts` — `SecretBoxError` (lint: one class per file outside `errors.ts`; the code blocks below show it inline for brevity, the implementation imports it from `errors.ts`).
- Create `packages/backend/src/infra/crypto/secret-box.test.ts`
- Create `packages/backend/src/infra/crypto/instance.ts` — `getSecretBox()`.
- Create `packages/backend/src/infra/crypto/instance.test.ts`
- Modify `packages/backend/src/infra/config/env.ts` — add `SECRETS_ENCRYPTION_KEYS`.
- Modify `packages/frontend/env/.env.example` — document the var.
- Modify `docs/reference/backend-conventions.md` — new "Secrets at rest" section.
- Modify `docs/reference/env.md` — list the var.

---

### Task 1: `SecretBox` seal/open with rotation

**Files:**
- Create: `packages/backend/src/infra/crypto/secret-box.ts`
- Test: `packages/backend/src/infra/crypto/secret-box.test.ts`

**Interfaces:**
- Produces:
  - `type SecretKey = { id: string; key: Buffer }`
  - `class SecretBoxError extends Error`
  - `class SecretBox { constructor(keys: readonly SecretKey[]); seal(plaintext: string, aad: string): string; open(sealed: string, aad: string): string; needsReseal(sealed: string): boolean }`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/backend/src/infra/crypto/secret-box.test.ts
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { SecretBox, SecretBoxError } from '@backend/infra/crypto/secret-box';

const keyA = { id: 'a', key: randomBytes(32) };
const keyB = { id: 'b', key: randomBytes(32) };
const AAD = 'mocco_inbound_sources:11111111-1111-1111-1111-111111111111';

describe('SecretBox', () => {
  it('round-trips ascii, empty and multi-byte plaintext', () => {
    const box = new SecretBox([keyA]);
    for (const plaintext of ['whsec_abc', '', '비밀 🔐 値']) {
      expect(box.open(box.seal(plaintext, AAD), AAD)).toBe(plaintext);
    }
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
    const flip = (s: string): string => (s.startsWith('A') ? `B${s.slice(1)}` : `A${s.slice(1)}`);
    expect(() => box.open([v, id, iv, ct, flip(tag ?? '')].join('.'), AAD)).toThrow(SecretBoxError);
    expect(() => box.open([v, id, iv, flip(ct ?? ''), tag].join('.'), AAD)).toThrow(SecretBoxError);
  });

  it('rejects malformed envelopes with SecretBoxError', () => {
    const box = new SecretBox([keyA]);
    for (const bad of ['', 'v1.a.x', 'v2.a.aa.bb.cc', 'v1.a.!!.@@.##', 'not-a-sealed-value']) {
      expect(() => box.open(bad, AAD)).toThrow(SecretBoxError);
    }
  });

  it('opens values sealed with an older key after rotation, and reports reseal', () => {
    const sealedWithA = new SecretBox([keyA]).seal('secret', AAD);
    const rotated = new SecretBox([keyB, keyA]);
    expect(rotated.open(sealedWithA, AAD)).toBe('secret');
    expect(rotated.needsReseal(sealedWithA)).toBe(true);
    expect(rotated.needsReseal(rotated.seal('secret', AAD))).toBe(false);
  });

  it('names the unknown key id once the old key is dropped, never the key material', () => {
    const sealedWithA = new SecretBox([keyA]).seal('secret', AAD);
    const onlyB = new SecretBox([keyB]);
    expect(() => onlyB.open(sealedWithA, AAD)).toThrow(/unknown key id "a"/);
  });

  it('requires at least one 32-byte key with unique ids', () => {
    expect(() => new SecretBox([])).toThrow(SecretBoxError);
    expect(() => new SecretBox([{ id: 'short', key: randomBytes(16) }])).toThrow(/"short"/);
    expect(() => new SecretBox([keyA, { id: 'a', key: randomBytes(32) }])).toThrow(/duplicate key id "a"/);
  });

  it('never puts plaintext or sealed text in error messages', () => {
    const box = new SecretBox([keyA]);
    const sealed = box.seal('super-secret-value', AAD);
    try {
      box.open(sealed, 'wrong');
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-value');
      expect(String(error)).not.toContain(sealed);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn backend test src/infra/crypto/secret-box.test.ts`
Expected: FAIL — cannot resolve `@backend/infra/crypto/secret-box`.

- [ ] **Step 3: Implement**

```ts
// packages/backend/src/infra/crypto/secret-box.ts
// SecretBox — authenticated encryption for third-party secrets at rest (platform
// foundations §3.0). AES-256-GCM with a fresh 12-byte IV per seal; the AAD binds a
// sealed value to its row ('<table>:<id>'), so a value copied into another row fails
// to open. Envelope: v1.<keyId>.<iv>.<ciphertext>.<tag> (base64url parts). The first
// key seals, every key opens — rotation = prepend a key, reseal, drop the old one.
// Errors never carry plaintext, key material or the sealed string.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretKey {
  id: string;
  key: Buffer;
}

export class SecretBoxError extends Error {}

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

function decodePart(part: string): Buffer {
  if (!BASE64URL.test(part)) {
    throw new SecretBoxError('sealed value is malformed');
  }
  return Buffer.from(part, 'base64url');
}

export class SecretBox {
  private readonly current: SecretKey;
  private readonly byId = new Map<string, Buffer>();

  constructor(keys: readonly SecretKey[]) {
    const [first] = keys;
    if (first === undefined) {
      throw new SecretBoxError('SecretBox needs at least one key');
    }
    for (const { id, key } of keys) {
      if (key.length !== KEY_BYTES) {
        throw new SecretBoxError(`key "${id}" must be ${KEY_BYTES} bytes`);
      }
      if (this.byId.has(id)) {
        throw new SecretBoxError(`duplicate key id "${id}"`);
      }
      this.byId.set(id, key);
    }
    this.current = first;
  }

  seal(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.current.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, this.current.id, iv, ciphertext, tag]
      .map(part => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  open(sealed: string, aad: string): string {
    const parts = sealed.split('.');
    const [version, keyId, ivPart, ciphertextPart, tagPart] = parts;
    if (
      parts.length !== 5 ||
      version !== VERSION ||
      keyId === undefined ||
      ivPart === undefined ||
      ciphertextPart === undefined ||
      tagPart === undefined
    ) {
      throw new SecretBoxError('sealed value is malformed');
    }
    const key = this.byId.get(keyId);
    if (key === undefined) {
      throw new SecretBoxError(`unknown key id "${keyId}"`);
    }
    const iv = decodePart(ivPart);
    const tag = decodePart(tagPart);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError('sealed value is malformed');
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(decodePart(ciphertextPart)), decipher.final()]).toString('utf8');
    } catch (error) {
      if (error instanceof SecretBoxError) {
        throw error;
      }
      // Wrong key, wrong AAD, or tampered bytes — GCM authentication failed.
      throw new SecretBoxError('sealed value failed authentication', { cause: error });
    }
  }

  /** True when `sealed` was made with a key other than the current sealing key. */
  needsReseal(sealed: string): boolean {
    return sealed.split('.')[1] !== this.current.id;
  }
}
```

If lint flags `Buffer` base64 usage with `unicorn/prefer-uint8array-base64`, add the same one-line disable comment and reason `env.ts` uses (Uint8Array base64 is still behind a V8 flag on Node 22).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn backend test src/infra/crypto/secret-box.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/infra/crypto/secret-box.ts packages/backend/src/infra/crypto/secret-box.test.ts
git commit -m "feat(platform): SecretBox — AES-256-GCM seal/open with rotatable keys"
```

### Task 2: Env var, key parsing and the lazy composition root

**Files:**
- Modify: `packages/backend/src/infra/crypto/secret-box.ts` (add `parseSecretKeys`)
- Modify: `packages/backend/src/infra/crypto/secret-box.test.ts`
- Modify: `packages/backend/src/infra/config/env.ts`
- Create: `packages/backend/src/infra/crypto/instance.ts`
- Create: `packages/backend/src/infra/crypto/instance.test.ts`

**Interfaces:**
- Consumes: `SecretBox`, `SecretBoxError`, `SecretKey` (Task 1).
- Produces: `parseSecretKeys(raw: string): SecretKey[]`; `getSecretBox(): SecretBox`; `createSecretBox(raw: string | undefined): SecretBox`; env key `SECRETS_ENCRYPTION_KEYS?: string`.

- [ ] **Step 1: Write the failing tests**

Add `parseSecretKeys` to the existing `@backend/infra/crypto/secret-box` import at the top of `secret-box.test.ts`, then append:

```ts
describe('parseSecretKeys', () => {
  const b64 = (): string => randomBytes(32).toString('base64');

  it('parses a comma list, trimming whitespace and ignoring empty entries', () => {
    const keys = parseSecretKeys(` k2:${b64()} , k1:${b64()},`);
    expect(keys.map(k => k.id)).toEqual(['k2', 'k1']);
    expect(keys.every(k => k.key.length === 32)).toBe(true);
  });

  it('rejects entries without a colon, bad ids and wrong-length keys by id only', () => {
    expect(() => parseSecretKeys('nocolon')).toThrow(SecretBoxError);
    expect(() => parseSecretKeys(`bad id:${b64()}`)).toThrow(SecretBoxError);
    const short = randomBytes(8).toString('base64');
    let message = '';
    try {
      parseSecretKeys(`k1:${short}`);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('"k1"');
    expect(message).not.toContain(short);
  });

  it('rejects an empty list', () => {
    expect(() => parseSecretKeys(' , ')).toThrow(SecretBoxError);
  });
});
```

Create `instance.test.ts`:

```ts
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createSecretBox } from '@backend/infra/crypto/instance';
import { SecretBoxError } from '@backend/infra/crypto/secret-box';

describe('createSecretBox', () => {
  it('fails loudly, naming the env var, only when a sealing feature asks for it', () => {
    expect(() => createSecretBox(undefined)).toThrow(/SECRETS_ENCRYPTION_KEYS/);
    expect(() => createSecretBox(undefined)).toThrow(SecretBoxError);
  });

  it('builds a working box from the env string', () => {
    const box = createSecretBox(`k1:${randomBytes(32).toString('base64')}`);
    expect(box.open(box.seal('x', 't:1'), 't:1')).toBe('x');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn backend test src/infra/crypto`
Expected: FAIL — `parseSecretKeys` / `@backend/infra/crypto/instance` not found.

- [ ] **Step 3: Implement**

Add to `secret-box.ts`:

```ts
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Parse `SECRETS_ENCRYPTION_KEYS` (`keyId:base64key,…`, first key seals). Messages
 * name the key id, never the key. */
export function parseSecretKeys(raw: string): SecretKey[] {
  const entries = raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
  if (entries.length === 0) {
    throw new SecretBoxError('SECRETS_ENCRYPTION_KEYS has no keys');
  }
  return entries.map((entry, index) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) {
      throw new SecretBoxError(`SECRETS_ENCRYPTION_KEYS entry ${index + 1} must be keyId:base64key`);
    }
    const id = entry.slice(0, separator);
    if (!KEY_ID.test(id)) {
      throw new SecretBoxError(`SECRETS_ENCRYPTION_KEYS entry ${index + 1} has an invalid key id`);
    }
    const key = Buffer.from(entry.slice(separator + 1), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new SecretBoxError(`key "${id}" must be ${KEY_BYTES} bytes (openssl rand -base64 32)`);
    }
    return { id, key };
  });
}
```

Add to the env schema in `env.ts` (after `GITHUB_WEBHOOK_SECRET`):

```ts
  /** SecretBox keys for third-party secrets at rest: `keyId:base64key,…` (first key
   * seals, all open). Generate a key with: openssl rand -base64 32. Optional — only
   * features that store secrets require it, and they fail loudly when it's absent. */
  SECRETS_ENCRYPTION_KEYS: z.string().min(1).optional(),
```

Create `instance.ts`:

```ts
// Production composition root for SecretBox. Lazy: importing never reads env, and a
// deploy without SECRETS_ENCRYPTION_KEYS boots fine — only a feature that seals or
// opens a secret fails, with a message naming the env var.
import { SecretBox, SecretBoxError, parseSecretKeys } from '@backend/infra/crypto/secret-box';
import { getEnv } from '@backend/infra/config/env';

export function createSecretBox(raw: string | undefined): SecretBox {
  if (raw === undefined) {
    throw new SecretBoxError('SECRETS_ENCRYPTION_KEYS is not set — required to store third-party secrets');
  }
  return new SecretBox(parseSecretKeys(raw));
}

const state: { box?: SecretBox } = {};

export function getSecretBox(): SecretBox {
  state.box ??= createSecretBox(getEnv().SECRETS_ENCRYPTION_KEYS);
  return state.box;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn backend test src/infra/crypto && yarn backend ts-check && yarn backend lint`
Expected: PASS, no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/infra/crypto packages/backend/src/infra/config/env.ts
git commit -m "feat(platform): SECRETS_ENCRYPTION_KEYS and a lazy SecretBox composition root"
```

### Task 3: Conventions and env docs

**Files:**
- Modify: `docs/reference/backend-conventions.md` (new section before `## Types & schemas`)
- Modify: `docs/reference/env.md` (add the var to the list of vars, same style as the GitHub vars)
- Modify: `packages/frontend/env/.env.example`

- [ ] **Step 1: Add the section to `backend-conventions.md`**

```markdown
## Secrets at rest (SecretBox)

Third-party secrets a customer gives Mocco (webhook signing secrets, bot tokens, store keys) are
sealed with `SecretBox` (`infra/crypto/secret-box.ts`, AES-256-GCM) before they reach the DB.

- Columns holding sealed values are named `*_sealed`. They never appear in a zod `.output()`;
  services project `hasSecret: boolean` instead, and a secret Mocco generates is returned once, at
  creation or rotation.
- The AAD is `'<table>:<row id>'`, so insert the row first (to get its id) and seal in the same
  service call, or generate the uuid in the service.
- Keys come from `SECRETS_ENCRYPTION_KEYS` (`keyId:base64key,…`). The first key seals, all keys
  open. To rotate: prepend a new key, reseal (`needsReseal` finds old values; the `secrets.reseal`
  job lands with the job queue), then drop the old key.
- Services receive the box by constructor injection; tests build one with a random key.
```

- [ ] **Step 2: Document the env var**

Append to `packages/frontend/env/.env.example`:

```
# SecretBox keys for third-party secrets at rest (webhook secrets, bot tokens).
# keyId:base64key[,older...] — first key seals, all keys open. Optional until a
# feature stores secrets. Generate: echo "k1:$(openssl rand -base64 32)"
SECRETS_ENCRYPTION_KEYS=
```

In `docs/reference/env.md`, add one row/bullet for `SECRETS_ENCRYPTION_KEYS` wherever the page lists backend vars (if it has no such list, add a short `## Secrets` section with the same three sentences as the `.env.example` comment). Bump `updated:` in both docs' frontmatter to `2026-09-25`.

- [ ] **Step 3: Verify**

Run: `yarn verify`
Expected: all green (format, docs:lint, lint, tests, drift, build).

- [ ] **Step 4: Commit**

```bash
git add docs/reference/backend-conventions.md docs/reference/env.md packages/frontend/env/.env.example
git commit -m "docs: SecretBox conventions and SECRETS_ENCRYPTION_KEYS"
```

## Out of scope

The `secrets.reseal` job (needs the job queue, #111) and any table with a `*_sealed` column (first one lands with #243).
