import { createSign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  isSignatureValid,
  parseSignatureHeader,
  readCertificate,
  serializeSignatureHeader,
} from '@backend/domain/ota/manifest/signature';
import {
  OTHER_SIGNING_KEY_PEM,
  TEST_SIGNING_CERT_PEM,
  TEST_SIGNING_KEY_PEM,
} from '@backend/domain/ota/testing/signing-fixtures';

const sign = (body: string, keyPem = TEST_SIGNING_KEY_PEM) =>
  createSign('RSA-SHA256').update(body, 'utf8').sign(keyPem, 'base64');

describe('expo-signature header', () => {
  it('parses the reference-server form and defaults keyid to "root" and alg to rsa-v1_5-sha256', () => {
    expect(parseSignatureHeader('sig="abc+/=", keyid="main"')).toEqual({
      sig: 'abc+/=',
      keyid: 'main',
      alg: 'rsa-v1_5-sha256',
    });
    expect(parseSignatureHeader('sig="abc"')).toEqual({ sig: 'abc', keyid: 'root', alg: 'rsa-v1_5-sha256' });
    expect(parseSignatureHeader('sig=:YWJj:, keyid="root", alg="rsa-v1_5-sha256"')?.sig).toBe('YWJj');
  });

  it('rejects headers that are not a dictionary with a sig', () => {
    expect(parseSignatureHeader('keyid="root"')).toBeNull();
    expect(parseSignatureHeader('sig')).toBeNull();
    expect(parseSignatureHeader('sig="a", "b"')).toBeNull();
  });

  it('serializes what it parses', () => {
    const header = serializeSignatureHeader({ sig: 'c2ln', keyid: 'root' });
    expect(parseSignatureHeader(header)).toMatchObject({ sig: 'c2ln', keyid: 'root' });
  });
});

describe('signature verification', () => {
  const body = JSON.stringify({ id: '1d3c5e2a-6a1b-4f4e-9b9a-2e7a7f4b1c11', createdAt: '2026-10-01T00:00:00.000Z' });

  it('accepts a signature over the exact bytes by the certificate key', () => {
    expect(isSignatureValid(body, sign(body), TEST_SIGNING_CERT_PEM)).toBe(true);
  });

  it('rejects a tampered body, another key, and garbage', () => {
    expect(isSignatureValid(`${body} `, sign(body), TEST_SIGNING_CERT_PEM)).toBe(false);
    expect(isSignatureValid(body, sign(body, OTHER_SIGNING_KEY_PEM), TEST_SIGNING_CERT_PEM)).toBe(false);
    expect(isSignatureValid(body, 'not base64 at all!', TEST_SIGNING_CERT_PEM)).toBe(false);
    expect(isSignatureValid(body, sign(body), 'not a certificate')).toBe(false);
  });

  it('reads an RSA certificate', () => {
    const info = readCertificate(TEST_SIGNING_CERT_PEM);
    expect(info.isRsa).toBe(true);
    expect(info.subject).toContain('Mocco OTA test signing');
    expect(info.spkiSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(info.notAfter.getTime()).toBeGreaterThan(Date.now());
  });
});
