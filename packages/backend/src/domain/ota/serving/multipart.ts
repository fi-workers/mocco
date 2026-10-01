// The Expo Updates protocol v1 response body: `multipart/mixed` with a `manifest` or a
// `directive` part carrying its own `expo-signature` header, and an `extensions` part.
// Parts are stored signed bytes; nothing here re-serializes them.
import { randomBytes } from 'node:crypto';

import { serializeSignatureHeader } from '@backend/domain/ota/manifest/signature';

import type { SignedPart } from '@backend/domain/ota/serving/select';

export type PartName = 'manifest' | 'directive';

const CRLF = '\r\n';

function partHeaders(name: string, contentType: string, signature: string | null): string {
  const lines = [`content-type: ${contentType}`, `content-disposition: form-data; name="${name}"`];
  if (signature !== null) {
    lines.push(`expo-signature: ${signature}`);
  }
  return lines.join(CRLF);
}

/** The `expo-signature` value of a stored part, or null when it is unsigned. */
export function signatureOf(part: SignedPart): string | null {
  return part.signature === null
    ? null
    : serializeSignatureHeader({ sig: part.signature, keyid: part.keyid ?? 'root' });
}

/** A multipart body and its content type. `boundary` is random unless given (tests). */
export function multipartOf(
  name: PartName,
  part: SignedPart,
  boundary = `mocco-${randomBytes(12).toString('hex')}`,
): { body: string; contentType: string } {
  const sections = [
    `--${boundary}${CRLF}${partHeaders(name, 'application/json; charset=utf-8', signatureOf(part))}${CRLF}${CRLF}${part.body}${CRLF}`,
    `--${boundary}${CRLF}${partHeaders('extensions', 'application/json', null)}${CRLF}${CRLF}${JSON.stringify({ assetRequestHeaders: {} })}${CRLF}`,
    `--${boundary}--${CRLF}`,
  ];
  return { body: sections.join(''), contentType: `multipart/mixed; boundary=${boundary}` };
}
