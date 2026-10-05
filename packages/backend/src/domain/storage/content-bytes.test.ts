import { describe, expect, it } from 'vitest';

import { sniffContentType } from '@backend/domain/storage/content-bytes';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap(part => (typeof part === 'string' ? [...new TextEncoder().encode(part)] : part)));

describe('sniffContentType', () => {
  it('recognizes the four image types by their signature', () => {
    expect(sniffContentType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffContentType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffContentType(bytes('GIF89a', [1, 0]))).toBe('image/gif');
    expect(sniffContentType(bytes('GIF87a'))).toBe('image/gif');
    expect(sniffContentType(bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
  });

  it('recognizes a PDF only by its header at the start', () => {
    expect(sniffContentType(bytes('%PDF-1.7\n', [0x25, 0xe2, 0xe3]))).toBe('application/pdf');
    expect(sniffContentType(bytes('%PDF'))).toBeNull();
    expect(sniffContentType(bytes(' %PDF-1.4'))).toBeNull();
  });

  it('refuses anything else, including SVG, HTML and truncated files', () => {
    expect(sniffContentType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffContentType(bytes('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffContentType(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
    expect(sniffContentType(bytes([0x89], 'PN'))).toBeNull();
    expect(sniffContentType(new Uint8Array())).toBeNull();
  });
});
