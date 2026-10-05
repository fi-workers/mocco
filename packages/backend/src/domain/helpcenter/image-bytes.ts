// What an uploaded article image really is, read from its first bytes. The declared
// content type is the uploader's word; the signature is what a browser will see.
import type { HelpImageType } from '@mocco/common/help';

const ascii = (text: string) => [...new TextEncoder().encode(text)];

/** Byte signatures: every part must match at its offset. */
const SIGNATURES: readonly { type: HelpImageType; parts: readonly { at: number; bytes: readonly number[] }[] }[] = [
  { type: 'image/png', parts: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }] },
  { type: 'image/jpeg', parts: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }] },
  { type: 'image/gif', parts: [{ at: 0, bytes: ascii('GIF87a') }] },
  { type: 'image/gif', parts: [{ at: 0, bytes: ascii('GIF89a') }] },
  {
    type: 'image/webp',
    parts: [
      { at: 0, bytes: ascii('RIFF') },
      { at: 8, bytes: ascii('WEBP') },
    ],
  },
];

/** The image type the bytes start with, or null when they aren't one of the help center's images. */
export function sniffImageType(bytes: Uint8Array): HelpImageType | null {
  const match = SIGNATURES.find(signature =>
    signature.parts.every(part => part.bytes.every((byte, index) => bytes[part.at + index] === byte)),
  );
  return match?.type ?? null;
}
