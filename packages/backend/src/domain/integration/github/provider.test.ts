import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { GithubApiError } from '@backend/domain/integration/github/errors';
import {
  decodeGetContent,
  toListedCommit,
  toRepo,
  toSourceCommit,
  verify,
} from '@backend/domain/integration/github/provider';

describe('verify', () => {
  // Not a real credential — a fixture value hashed in-test with node:crypto to
  // compute a known-good HMAC (sonarjs flags any `secret`-named literal used
  // to key an HMAC as a hardcoded credential).
  const secret = 'a-test-webhook-secret';
  const rawBody = JSON.stringify({ hello: 'world' });
  // eslint-disable-next-line sonarjs/hardcoded-secret-signatures
  const validSignature = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

  it('returns true for a body signed with the matching secret', () => {
    expect(verify(rawBody, validSignature, secret)).toBe(true);
  });

  it('returns false when the body was tampered with after signing', () => {
    const tamperedBody = JSON.stringify({ hello: 'mallory' });
    expect(verify(tamperedBody, validSignature, secret)).toBe(false);
  });

  it('returns false when the signature was tampered with', () => {
    // sonarjs/null-dereference is a false positive: validSignature is always a
    // string (built from a template literal above), never null/undefined.
    // eslint-disable-next-line sonarjs/null-dereference
    const tamperedSignature = `${validSignature.slice(0, -1)}${validSignature.endsWith('0') ? '1' : '0'}`;
    expect(verify(rawBody, tamperedSignature, secret)).toBe(false);
  });

  it('returns false (does not throw) for a malformed signature', () => {
    expect(() => verify(rawBody, 'not-a-valid-signature', secret)).not.toThrow();
    expect(verify(rawBody, 'not-a-valid-signature', secret)).toBe(false);
  });

  it('returns false when no signature header was sent', () => {
    expect(verify(rawBody, null, secret)).toBe(false);
  });
});

describe('toSourceCommit', () => {
  it('maps a push-webhook commit to a neutral SourceCommit', () => {
    const raw = {
      id: '1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d',
      message: 'fix: correct off-by-one error',
      timestamp: '2026-07-18T10:00:00Z',
      author: { name: 'Ada Lovelace', email: 'ada@example.com' },
    };
    expect(toSourceCommit(raw)).toEqual({
      sha: '1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d',
      message: 'fix: correct off-by-one error',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
      committedAt: new Date('2026-07-18T10:00:00Z'),
    });
  });
});

describe('toListedCommit', () => {
  it('maps a REST list-commits item (nested commit.author) to a neutral SourceCommit', () => {
    const raw = {
      sha: '9f8e7d6c5b4a3928170695847362514a3b2c1d0',
      commit: {
        message: 'chore: bump deps',
        author: { name: 'Grace Hopper', email: 'grace@example.com', date: '2026-07-17T09:30:00Z' },
      },
    };
    expect(toListedCommit(raw)).toEqual({
      sha: '9f8e7d6c5b4a3928170695847362514a3b2c1d0',
      message: 'chore: bump deps',
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
      committedAt: new Date('2026-07-17T09:30:00Z'),
    });
  });

  it('falls back to empty strings/epoch when GitHub reports a null git author', () => {
    const raw = { sha: 'deadbeef', commit: { message: 'msg', author: null } };
    expect(toListedCommit(raw)).toEqual({
      sha: 'deadbeef',
      message: 'msg',
      authorName: '',
      authorEmail: '',
      committedAt: new Date(0),
    });
  });
});

describe('decodeGetContent', () => {
  it('decodes a base64 file payload to the expected UTF-8 text', () => {
    const text = 'gate: production\ntimeout: 30\n';
    const raw = {
      type: 'file',
      encoding: 'base64',
      // Buffer is the available base64 encoder on this runtime (see provider.ts#decodeGetContent).
      // eslint-disable-next-line unicorn/prefer-uint8array-base64
      content: Buffer.from(text, 'utf8').toString('base64'),
      size: text.length,
      name: '.mocco.yml',
      path: '.mocco.yml',
      sha: 'abc123',
    };
    expect(decodeGetContent(raw)).toBe(text);
  });

  it('decodes correctly even when GitHub line-wraps the base64 content with newlines', () => {
    const text = 'a'.repeat(200);
    // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- see above.
    const wrapped = Buffer.from(text, 'utf8').toString('base64').replaceAll(/.{60}/g, '$&\n');
    expect(decodeGetContent({ type: 'file', encoding: 'base64', content: wrapped })).toBe(text);
  });

  it('rejects a directory listing (array response) with a mapped GithubApiError, not a crash', () => {
    const raw = [{ type: 'file', name: 'a.txt', path: 'a.txt', sha: 'x' }];
    expect(() => decodeGetContent(raw)).toThrow(GithubApiError);
  });

  it('rejects a response with no content field (e.g. a symlink) with a mapped GithubApiError', () => {
    const raw = { type: 'symlink', target: 'other/path', size: 4, name: '.mocco.yml', path: '.mocco.yml', sha: 'x' };
    expect(() => decodeGetContent(raw)).toThrow(GithubApiError);
  });
});

describe('toRepo', () => {
  it('maps a GitHub repo to a neutral AvailableRepoDto', () => {
    const raw = { id: 987_654, name: 'api', default_branch: 'main', owner: { login: 'fi-workers' } };
    expect(toRepo(raw)).toEqual({
      externalRepoId: '987654',
      owner: 'fi-workers',
      name: 'api',
      defaultBranch: 'main',
    });
  });

  it('stringifies the numeric id (external ids are strings across providers)', () => {
    expect(toRepo({ id: 1, name: 'n', default_branch: 'trunk', owner: { login: 'o' } }).externalRepoId).toBe('1');
  });
});
