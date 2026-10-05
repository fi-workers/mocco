// Production composition root for OG images. Lazy, so builds don't need env or fonts at
// import. Fonts and the emoji pack are read from this folder: `next build` traces them into
// the ext route (next.config.ts), whose working directory is the frontend package.
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { createOgFallbacks } from '@backend/domain/og/fallback';
import { OgImageService } from '@backend/domain/og/OgImageService';
import { createOgRenderer } from '@backend/domain/og/renderer';
import { getStorageDomain } from '@backend/domain/storage/instance';
import { getBuildEnv } from '@backend/infra/config/env';

import type { OgFont } from '@backend/domain/og/renderer';

/**
 * The folder holding `fonts/` and `emoji/`, from the frontend package (Next) or the backend
 * package (tests).
 */
export function ogAssetsDir(cwd: string): string {
  const fromBackend = path.join(cwd, 'src', 'domain', 'og');
  return path.basename(cwd) === 'backend' ? fromBackend : path.join(cwd, '..', 'backend', 'src', 'domain', 'og');
}

export async function loadOgFonts(dir: string): Promise<OgFont[]> {
  return [
    { name: 'Pretendard', weight: 400, data: await readFile(path.join(dir, 'fonts', 'Pretendard-Regular.ttf')) },
    { name: 'Pretendard', weight: 600, data: await readFile(path.join(dir, 'fonts', 'Pretendard-SemiBold.ttf')) },
  ];
}

const state: { og?: OgImageService | null } = {};

/**
 * The OG image service, or undefined without AUTH_SECRET (nothing to sign with). Building
 * it reads only the secret, so pages can issue cards during `next build`; fonts and the
 * store are reached only when an image is served.
 */
export function getOgImages(): OgImageService | undefined {
  if (state.og === undefined) {
    const env = getBuildEnv();
    state.og =
      env.AUTH_SECRET === undefined
        ? null
        : new OgImageService({
            secret: createHmac('sha256', env.AUTH_SECRET).update('mocco-og-images').digest('base64url'),
            render: createOgRenderer(async () => await loadOgFonts(ogAssetsDir(process.cwd())), {
              fallbacks: createOgFallbacks(ogAssetsDir(process.cwd())),
            }),
            store: () => getStorageDomain()?.store,
          });
  }
  return state.og ?? undefined;
}
