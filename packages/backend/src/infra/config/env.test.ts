import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const base = {
  DATABASE_URL: 'postgres://x',
  GITHUB_APP_ID: '4284809',
  GITHUB_APP_SLUG: 'mocco-club',
  GITHUB_APP_CLIENT_ID: 'Iv1',
  GITHUB_APP_CLIENT_SECRET: 's',
};

const pkcs8Pem = '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----';
const pkcs1Pem = '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----';

/** Buffer is the only base64 encoder available without the V8 --js-base-64 flag. */
// eslint-disable-next-line unicorn/prefer-uint8array-base64
const toBase64 = (pem: string): string => Buffer.from(pem).toString('base64');

function stubBase(privateKeyB64?: string): void {
  vi.stubEnv('DATABASE_URL', base.DATABASE_URL);
  vi.stubEnv('GITHUB_APP_ID', base.GITHUB_APP_ID);
  vi.stubEnv('GITHUB_APP_SLUG', base.GITHUB_APP_SLUG);
  vi.stubEnv('GITHUB_APP_CLIENT_ID', base.GITHUB_APP_CLIENT_ID);
  vi.stubEnv('GITHUB_APP_CLIENT_SECRET', base.GITHUB_APP_CLIENT_SECRET);
  if (privateKeyB64 !== undefined) {
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY_B64', privateKeyB64);
  }
}

describe('getEnv', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a PKCS#1 private key', async () => {
    stubBase(toBase64(pkcs1Pem));
    const { getEnv } = await import('./env');
    expect(() => getEnv()).toThrow(/PKCS#8/);
  });

  it('decodes a valid PKCS#8 private key and keeps the GitHub App vars', async () => {
    stubBase(toBase64(pkcs8Pem));
    const { getEnv } = await import('./env');
    const env = getEnv();
    expect(env.GITHUB_APP_PRIVATE_KEY_B64).toBe(pkcs8Pem);
    expect(env.GITHUB_APP_ID).toBe(base.GITHUB_APP_ID);
    expect(env.GITHUB_APP_SLUG).toBe(base.GITHUB_APP_SLUG);
    expect(env.GITHUB_APP_CLIENT_ID).toBe(base.GITHUB_APP_CLIENT_ID);
    expect(env.GITHUB_APP_CLIENT_SECRET).toBe(base.GITHUB_APP_CLIENT_SECRET);
  });

  it('boots without any GitHub App vars set (optional)', async () => {
    vi.stubEnv('DATABASE_URL', base.DATABASE_URL);
    const { getEnv } = await import('./env');
    expect(() => getEnv()).not.toThrow();
  });

  it('exposes GITHUB_WEBHOOK_SECRET when set', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://x');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'whsec');
    const { getEnv } = await import('./env');
    expect(getEnv().GITHUB_WEBHOOK_SECRET).toBe('whsec');
  });
});
