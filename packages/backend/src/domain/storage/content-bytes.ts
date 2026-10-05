// What an uploaded file really is, read from its first bytes. The declared content type
// is the uploader's word; the signature is what a browser or a PDF reader will see.
// Products that serve uploads to other people (help center images, messenger
// attachments) check that both agree before they serve anything.

const ascii = (text: string) => [...new TextEncoder().encode(text)];

/** The content types a signature can identify. */
export const SniffedContentTypes = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
} as const;
export type SniffedContentType = (typeof SniffedContentTypes)[keyof typeof SniffedContentTypes];

/** Byte signatures: every part must match at its offset. */
const SIGNATURES: readonly {
  type: SniffedContentType;
  parts: readonly { at: number; bytes: readonly number[] }[];
}[] = [
  { type: SniffedContentTypes.png, parts: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }] },
  { type: SniffedContentTypes.jpeg, parts: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }] },
  { type: SniffedContentTypes.gif, parts: [{ at: 0, bytes: ascii('GIF87a') }] },
  { type: SniffedContentTypes.gif, parts: [{ at: 0, bytes: ascii('GIF89a') }] },
  {
    type: SniffedContentTypes.webp,
    parts: [
      { at: 0, bytes: ascii('RIFF') },
      { at: 8, bytes: ascii('WEBP') },
    ],
  },
  { type: SniffedContentTypes.pdf, parts: [{ at: 0, bytes: ascii('%PDF-') }] },
];

/** The content type the bytes start with, or null when they aren't one of the known kinds. */
export function sniffContentType(bytes: Uint8Array): SniffedContentType | null {
  const match = SIGNATURES.find(signature =>
    signature.parts.every(part => part.bytes.every((byte, index) => bytes[part.at + index] === byte)),
  );
  return match?.type ?? null;
}
