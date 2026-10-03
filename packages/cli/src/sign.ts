import { createPrivateKey, sign } from 'node:crypto';

/** rsa-v1_5-sha256 over the exact body — what expo-updates verifies against the embedded certificate. */
export function signBody(body: string, privateKeyPem: string, keyid: string): { sig: string; keyid: string } {
  const key = createPrivateKey(privateKeyPem);
  // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array#toBase64 isn't in Node 22
  return { sig: sign('sha256', Buffer.from(body), key).toString('base64'), keyid };
}
