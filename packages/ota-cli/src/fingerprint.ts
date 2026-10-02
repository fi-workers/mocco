// `runtimeVersion: { policy: "fingerprint" }` — the value expo-updates embeds in the
// binary. It is computed by the project's own Expo CLI, so what this CLI publishes under
// is exactly what the build will ask for. iOS and Android hash differently (different
// native dependencies and config), so each platform is resolved on its own.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import { CliError } from './errors';

import type { OtaPlatform } from '@mocco/common/ota-hosting';

const run = promisify(execFile);

/** `fingerprint:generate` prints the whole fingerprint; its `hash` is the runtime version. */
const fingerprintSchema = z.object({ hash: z.string().min(1) });

/** The output lists every source file, so it runs to megabytes on a large project. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** What the project's Expo CLI is asked to run, as `execFile` takes it. */
export function fingerprintCommandOf(platform: OtaPlatform): { command: string; args: string[] } {
  return { command: 'npx', args: ['expo-updates', 'fingerprint:generate', '--platform', platform] };
}

/** The hash out of `fingerprint:generate`'s output, or a CliError naming what to fix. */
export function parseFingerprint(stdout: string, platform: OtaPlatform): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new CliError(`expo-updates fingerprint:generate didn't print JSON for ${platform}`, { cause: error });
  }
  const fingerprint = fingerprintSchema.safeParse(parsed);
  if (!fingerprint.success) {
    throw new CliError(`expo-updates fingerprint:generate printed no hash for ${platform}`);
  }
  return fingerprint.data.hash;
}

/** The fingerprint hash of `platform`, as `expo-updates` computes it for the build. */
export async function fingerprintOf(projectDir: string, platform: OtaPlatform): Promise<string> {
  const { command, args } = fingerprintCommandOf(platform);
  let stdout: string;
  try {
    ({ stdout } = await run(command, args, { cwd: projectDir, maxBuffer: MAX_OUTPUT_BYTES }));
  } catch (error) {
    throw new CliError(
      `Couldn't compute the ${platform} fingerprint — is expo-updates installed in the project? (pass --runtime-version to skip it)`,
      { cause: error },
    );
  }
  return parseFingerprint(stdout, platform);
}
