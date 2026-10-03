import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { scanArchive } from '@backend/domain/flags/code-refs';

/** A minimal ustar archive of `files`, under one top directory like GitHub's. */
async function archive(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const blocks = Object.entries(files).flatMap(([path, content]) => {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(`acme-app-abc123/${path}`), 0);
    header.set(new TextEncoder().encode(`${data.length.toString(8).padStart(11, '0')}\0`), 124);
    header[156] = '0'.codePointAt(0) ?? 48;
    const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
    body.set(data);
    return [header, body];
  });
  const tar = new Uint8Array([...blocks.flatMap(block => [...block]), ...new Uint8Array(1024)]);
  return await promisify(gzip)(tar);
}

describe('scanArchive', () => {
  it('finds quoted keys in text files, and skips vendored, binary and unquoted mentions', async () => {
    const gz = await archive({
      'src/checkout.ts': "if (client.getBooleanValue('checkout_v2', false)) {}",
      'src/onboarding.tsx': 'useFlag(`onboarding`)',
      'node_modules/lib/index.js': "flag('vendored_only')",
      'assets/logo.png': new Uint8Array([0, 1, 2, 3, ...new TextEncoder().encode("'binary_only'")]),
      'README.md': 'The old_banner flag is gone.',
    });

    const scan = await scanArchive(gz, ['checkout_v2', 'onboarding', 'vendored_only', 'binary_only', 'old_banner']);

    expect(scan.found).toEqual(new Set(['checkout_v2', 'onboarding']));
    expect(scan.isComplete).toBe(true);
  });
});
