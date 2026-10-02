// Code signing for Mocco-hosted OTA (ADRs 0021, 0022). Pure: parse and build the
// `expo-signature` header (an RFC 8941 structured-field dictionary), read an X.509
// certificate, and verify `rsa-v1_5-sha256` over the exact signed bytes. expo-updates
// verifies the same bytes on the device, so Mocco checks them before storing anything.
import { createHash, verify, X509Certificate } from 'node:crypto';

import { DEFAULT_SIGNING_KEY_ID, SIGNING_ALGORITHM } from '@mocco/common/ota-hosting';

export interface SignatureHeader {
  /** The signature, base64. */
  sig: string;
  keyid: string;
  alg: string;
}

const MEMBER_NAME = /^[a-z*][a-z0-9_.*-]*$/u;

/** One SFV dictionary member's value: a quoted string, a `:byte sequence:`, a token, or
 * `true` for a bare name. Null when it is none of these. */
function memberValue(raw: string | undefined): string | null {
  if (raw === undefined) {
    return 'true';
  }
  // eslint-disable-next-line sonarjs/null-dereference -- narrowed to a string above
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replaceAll(/\\(.)/gu, '$1');
  }
  if (raw.length >= 2 && raw.startsWith(':') && raw.endsWith(':')) {
    return raw.slice(1, -1);
  }
  return /^[A-Za-z*][\w:/.*+-]*$/u.test(raw) ? raw : null;
}

/** `name=value` → [name, value], or null when it isn't a dictionary member. */
function parseMember(member: string): readonly [string, string] | null {
  // eslint-disable-next-line sonarjs/null-dereference -- member is a string, never null
  const trimmed = member.trim();
  // eslint-disable-next-line sonarjs/null-dereference -- trimmed is a string, never null
  const equals = trimmed.indexOf('=');
  const name = equals === -1 ? trimmed : trimmed.slice(0, equals);
  const value = memberValue(equals === -1 ? undefined : trimmed.slice(equals + 1));
  return MEMBER_NAME.test(name) && value !== null ? [name, value] : null;
}

/**
 * Parse an `expo-signature` value such as `sig="…", keyid="root"`. `keyid` defaults to
 * expo-updates' `"root"` and `alg` to `rsa-v1_5-sha256`. Null when the header isn't a
 * dictionary or has no `sig`.
 *
 * sonarjs/function-return-type is a false positive here: every branch returns the
 * declared `SignatureHeader | null`.
 */
// eslint-disable-next-line sonarjs/function-return-type
export function parseSignatureHeader(value: string): SignatureHeader | null {
  // eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
  const parsed = value.split(',').map(member => parseMember(member));
  if (parsed.includes(null)) {
    return null;
  }
  const members = new Map(parsed.filter(member => member !== null));
  const sig = members.get('sig');
  if (sig === undefined || ['', 'true'].includes(sig)) {
    return null;
  }
  return {
    sig,
    keyid: members.get('keyid') ?? DEFAULT_SIGNING_KEY_ID,
    alg: members.get('alg') ?? SIGNING_ALGORITHM,
  };
}

/** The header value for a signature, in the form Expo's reference server sends. */
export function serializeSignatureHeader(signature: { sig: string; keyid: string }): string {
  return `sig="${signature.sig}", keyid="${signature.keyid}"`;
}

export interface CertificateInfo {
  /** SHA-256 (hex) of the DER public key. */
  spkiSha256: string;
  subject: string;
  notBefore: Date;
  notAfter: Date;
  isRsa: boolean;
}

/** Read a PEM certificate. Throws on anything that isn't a certificate. */
export function readCertificate(pem: string): CertificateInfo {
  const certificate = new X509Certificate(pem);
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
  return {
    spkiSha256: createHash('sha256').update(spki).digest('hex'),
    subject: certificate.subject.replaceAll('\n', ', '),
    notBefore: new Date(certificate.validFrom),
    notAfter: new Date(certificate.validTo),
    isRsa: certificate.publicKey.asymmetricKeyType === 'rsa',
  };
}

/** Whether `sigBase64` is an `rsa-v1_5-sha256` signature of exactly `body` by the
 * certificate's key. Never throws for a malformed signature. */
export function isSignatureValid(body: string, sigBase64: string, certificatePem: string): boolean {
  try {
    const { publicKey } = new X509Certificate(certificatePem);
    // Uint8Array.fromBase64 isn't available on Node 22, which the repo supports (engines >=22).
    // eslint-disable-next-line unicorn/prefer-uint8array-base64
    return verify('sha256', Buffer.from(body, 'utf8'), publicKey, Buffer.from(sigBase64, 'base64'));
  } catch {
    return false;
  }
}
