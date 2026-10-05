import { describe, expect, it } from 'vitest';

import { createOgRoutes } from '@backend/transport/ext/og';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

describe('OG image route', () => {
  it('serves an issued image as an immutable PNG and 404s anything else', async () => {
    const seen: unknown[] = [];
    const app = createOgRoutes({
      image: async (template, file, data) => {
        seen.push([template, file, data]);
        return await Promise.resolve(file === 'good.png' ? PNG : undefined);
      },
    });

    const ok = await app.request('/og/v1/article/good.png?d=abc');
    const bad = await app.request('/og/v1/article/bad.png?d=abc');
    const off = await createOgRoutes(undefined).request('/og/v1/article/good.png?d=abc');

    expect([ok.status, ok.headers.get('content-type'), ok.headers.get('cache-control')]).toEqual([
      200,
      'image/png',
      'public, max-age=31536000, immutable',
    ]);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(PNG);
    expect([bad.status, off.status]).toEqual([404, 404]);
    expect(seen[0]).toEqual(['article', 'good.png', 'abc']);
  });
});
