// Reads what `expo export` wrote: `dist/metadata.json` lists each platform's bundle and
// assets, relative to the output directory.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { contentTypeOf } from './content-types';
import { CliError } from './errors';

import type { OtaPlatform } from '@mocco/common/ota-hosting';

const metadataSchema = z.object({
  fileMetadata: z.record(
    z.string(),
    z.object({
      bundle: z.string(),
      assets: z.array(z.object({ path: z.string(), ext: z.string() })),
    }),
  ),
});

/**
 * The `expo export` command line for `platforms`, naming each one.
 *
 * Never `--platform all`: that means every platform the Expo config declares, so a project
 * that also targets web exports web too — bytes OTA never serves, and a web-only bundling
 * failure that fails the publish (`expo-sqlite`'s wasm import is one).
 */
export function exportCommandOf(
  platforms: readonly OtaPlatform[],
  distDir: string,
): { command: string; args: string[] } {
  return {
    command: 'npx',
    args: ['expo', 'export', ...platforms.flatMap(platform => ['--platform', platform]), '--output-dir', distDir],
  };
}

export interface ExportedFile {
  path: string;
  ext: string | null;
  contentType: string;
  bytes: Buffer;
  /** base64url SHA-256: the asset's name and integrity check on the device. */
  hash: string;
  /** Hex MD5: the manifest `key` (what Expo's own servers use). */
  key: string;
}

export interface PlatformExport {
  platform: OtaPlatform;
  bundle: ExportedFile;
  assets: ExportedFile[];
}

async function readFileOf(distDir: string, relative: string, ext: string | null, contentType?: string) {
  const bytes = await readFile(path.join(distDir, relative));
  return {
    path: relative,
    ext,
    contentType: contentType ?? contentTypeOf(ext),
    bytes,
    hash: createHash('sha256').update(bytes).digest('base64url'),
    // eslint-disable-next-line sonarjs/hashing -- the manifest key only names the file, as Expo's servers do; integrity is the SHA-256
    key: createHash('md5').update(bytes).digest('hex'),
  } satisfies ExportedFile;
}

/** Each requested platform's bundle and assets, read and hashed. */
export async function readExport(distDir: string, platforms: readonly OtaPlatform[]): Promise<PlatformExport[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(distDir, 'metadata.json'), 'utf8');
  } catch (error) {
    throw new CliError(`${distDir}/metadata.json is missing; run \`npx expo export\` first`, { cause: error });
  }
  const parsed = metadataSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new CliError(`${distDir}/metadata.json isn't an expo export metadata file`);
  }
  return await Promise.all(
    platforms.map(async platform => {
      const files = parsed.data.fileMetadata[platform];
      if (files === undefined) {
        throw new CliError(`The export has no ${platform} bundle; export with --platform ${platform}`);
      }
      return {
        platform,
        bundle: await readFileOf(distDir, files.bundle, 'bundle', 'application/javascript'),
        assets: await Promise.all(files.assets.map(async asset => await readFileOf(distDir, asset.path, asset.ext))),
      };
    }),
  );
}
