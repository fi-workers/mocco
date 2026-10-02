// Reads the Expo app config (`app.json`) the CLI needs: the Mocco manifest URL (which
// names the API base and the app id), the code-signing keyid and the runtime version.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_SIGNING_KEY_ID } from '@mocco/common/ota-hosting';
import { z } from 'zod';

import { CliError } from './errors';

import type { OtaPlatform } from '@mocco/common/ota-hosting';

export interface ExpoConfig {
  version?: string;
  /** A literal, or a policy such as `{ policy: "appVersion" }` (parsed in runtimeVersionOf). */
  runtimeVersion?: unknown;
  updates?: {
    url?: string;
    codeSigningMetadata?: { keyid?: string; alg?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const runtimeVersionSchema = z.union([z.string().min(1), z.object({ policy: z.string() })]);

const MANIFEST_URL = /^(?<base>https?:\/\/.+)\/ota\/apps\/(?<appId>[\da-f-]{36})\/manifest$/u;

export async function readAppJson(projectDir: string): Promise<{ file: string; json: { expo?: ExpoConfig } }> {
  const file = path.join(projectDir, 'app.json');
  try {
    return { file, json: JSON.parse(await readFile(file, 'utf8')) as { expo?: ExpoConfig } };
  } catch (error) {
    throw new CliError(`Couldn't read ${file}; run in the Expo project or pass --project`, { cause: error });
  }
}

export async function writeAppJson(file: string, json: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
}

/** The API base and app id in a Mocco manifest URL (`…/v1/ota/apps/<id>/manifest`). */
export function parseManifestUrl(url: string): { apiBase: string; appId: string } {
  const match = MANIFEST_URL.exec(url);
  if (match?.groups?.base === undefined || match.groups.appId === undefined) {
    throw new CliError(`${url} isn't a Mocco manifest URL (…/ota/apps/<app id>/manifest)`);
  }
  return { apiBase: match.groups.base, appId: match.groups.appId };
}

export function keyidOf(config: ExpoConfig): string {
  return config.updates?.codeSigningMetadata?.keyid ?? DEFAULT_SIGNING_KEY_ID;
}

/** The `fingerprint` policy, which only the project's own Expo CLI can resolve, per platform. */
export function isFingerprintPolicy(config: ExpoConfig): boolean {
  const parsed = runtimeVersionSchema.safeParse(config.runtimeVersion);
  return parsed.success && typeof parsed.data !== 'string' && parsed.data.policy === 'fingerprint';
}

/** The runtime version: a literal, or the `appVersion` policy. Other policies need the flag. */
export function runtimeVersionOf(config: ExpoConfig, platform: OtaPlatform): string {
  const parsed = runtimeVersionSchema.safeParse(config.runtimeVersion);
  const value = parsed.success ? parsed.data : undefined;
  if (typeof value === 'string') {
    return value;
  }
  if (value?.policy === 'appVersion' && config.version !== undefined) {
    return config.version;
  }
  throw new CliError(
    `Can't work out the ${platform} runtime version from app.json (policy ${value?.policy ?? 'unset'}); pass --runtime-version`,
  );
}
