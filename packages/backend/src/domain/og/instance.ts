// Production composition root for OG images. Lazy, so builds don't need env or fonts at
// import. Fonts are read from this folder: `next build` traces them into the ext route
// (next.config.ts), whose working directory is the frontend package.
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { OgImageService } from '@backend/domain/og/OgImageService';
import { createOgRenderer } from '@backend/domain/og/renderer';
import { getStorageDomain } from '@backend/domain/storage/instance';
import { getEnv } from '@backend/infra/config/env';

import type { OgFont } from '@backend/domain/og/renderer';

/** Where the fonts live, from the frontend package (Next) or the backend package (tests). */
export function ogFontsDir(cwd: string): string {
  const fromBackend = path.join(cwd, 'src', 'domain', 'og', 'fonts');
  return path.basename(cwd) === 'backend'
    ? fromBackend
    : path.join(cwd, '..', 'backend', 'src', 'domain', 'og', 'fonts');
}

export async function loadOgFonts(dir: string): Promise<OgFont[]> {
  return [
    { name: 'Pretendard', weight: 400, data: await readFile(path.join(dir, 'Pretendard-Regular.ttf')) },
    { name: 'Pretendard', weight: 600, data: await readFile(path.join(dir, 'Pretendard-SemiBold.ttf')) },
  ];
}

const state: { og?: OgImageService | null } = {};

/** The OG image service, or undefined without AUTH_SECRET (nothing to sign with). */
export function getOgImages(): OgImageService | undefined {
  if (state.og === undefined) {
    const env = getEnv();
    const store = getStorageDomain()?.store;
    state.og =
      env.AUTH_SECRET === undefined
        ? null
        : new OgImageService({
            secret: createHmac('sha256', env.AUTH_SECRET).update('mocco-og-images').digest('base64url'),
            render: createOgRenderer(async () => await loadOgFonts(ogFontsDir(process.cwd()))),
            ...(store !== undefined && { store }),
          });
  }
  return state.og ?? undefined;
}
