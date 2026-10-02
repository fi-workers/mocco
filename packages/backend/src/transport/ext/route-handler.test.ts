import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('the ext route handler (frontend app/api/ext)', () => {
  it('hands every method the ext app serves to Hono, OPTIONS included', async () => {
    // Next answers a method the route file doesn't export by itself: for OPTIONS that is a
    // preflight without Access-Control-* headers, which breaks every browser SDK call.
    const route = await readFile(
      fileURLToPath(new URL('../../../../frontend/src/app/api/ext/[[...route]]/route.ts', import.meta.url)),
      'utf8',
    );
    const exported = new Set(Array.from(route.matchAll(/^export const ([A-Z]+) = /gmu), match => match[1]));
    expect(exported).toEqual(new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']));
  });
});
