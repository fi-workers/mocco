import { describe, expect, it } from 'vitest';

import { sniffImageType } from '@backend/domain/helpcenter/image-bytes';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap(part => (typeof part === 'string' ? [...new TextEncoder().encode(part)] : part)));

describe('sniffImageType', () => {
  it('recognizes the four help center image types by their signature', () => {
    expect(sniffImageType(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(bytes('GIF89a', [1, 0]))).toBe('image/gif');
    expect(sniffImageType(bytes('GIF87a'))).toBe('image/gif');
    expect(sniffImageType(bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '))).toBe('image/webp');
  });

  it('refuses anything else, including SVG and truncated files', () => {
    expect(sniffImageType(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
    expect(sniffImageType(bytes([0x89], 'PN'))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});
