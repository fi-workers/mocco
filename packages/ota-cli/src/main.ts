// The `mocco-ota` command line: argument parsing, environment and process glue around
// `init` and `publish`. Errors print one line saying what to fix and exit 1.
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

import { DEFAULT_SIGNING_KEY_ID, OtaPlatforms } from '@mocco/common/ota-hosting';

import { keyidOf, parseManifestUrl, readAppJson, runtimeVersionOf } from './app-config';
import { CliError } from './errors';
import { isPresent } from './fs';
import { init, KEY_FILE } from './init';
import { promote } from './promote';
import { publish } from './publish';

import type { OtaPlatform } from '@mocco/common/ota-hosting';

const USAGE = `Usage:
  mocco-ota init --manifest-url <url> [--channel production] [--keyid root] [--project .]
      Make the signing key and certificate, and point app.json at Mocco.
      Copy the manifest URL from the console (OTA hosting → Connect the app).

  mocco-ota publish [--channel <name>] [--platform ios|android|all] [--message <text>]
                    [--mandatory] [--skip-export] [--dist dist] [--runtime-version <v>]
                    [--signing-key <file>] [--git-sha <sha>] [--project .]
      Export, upload and finalize a signed release; with --channel, promote it once ready.
      Needs MOCCO_API_KEY (a secret key with ota:write) and the signing key in
      MOCCO_OTA_SIGNING_KEY, --signing-key or ${KEY_FILE}.

  mocco-ota promote --release <id> --channel <name> [--project .]
      Point an unprotected channel at a ready release. Needs MOCCO_API_KEY.
`;

const run = promisify(execFile);

const log = (line: string) => {
  process.stdout.write(`${line}\n`);
};

/** `git` output in the project, or null outside a repository. */
async function gitOutput(projectDir: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', [...args], { cwd: projectDir });
    // eslint-disable-next-line sonarjs/null-dereference -- execFile's stdout is a string
    const output = stdout.trim();
    return output === '' ? null : output;
  } catch {
    return null;
  }
}

function platformsOf(value: string): OtaPlatform[] {
  if (value === 'all') {
    return [OtaPlatforms.ios, OtaPlatforms.android];
  }
  if (value === OtaPlatforms.ios || value === OtaPlatforms.android) {
    return [value];
  }
  throw new CliError(`--platform must be ios, android or all (got ${value})`);
}

async function expoExport(projectDir: string, platform: string, distDir: string): Promise<void> {
  log(`Running expo export --platform ${platform}…`);
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- runs the project's own Expo CLI, as a developer would
  const child = spawn('npx', ['expo', 'export', '--platform', platform, '--output-dir', distDir], {
    cwd: projectDir,
    stdio: 'inherit',
  });
  const code = await new Promise<number | null>(resolve => {
    child.on('close', resolve);
  });
  if (code !== 0) {
    throw new CliError(`expo export exited with ${String(code)}`);
  }
}

async function signingKeyOf(projectDir: string, flag: string | undefined): Promise<string> {
  if (flag !== undefined) {
    return await readFile(path.resolve(projectDir, flag), 'utf8');
  }
  const fromEnv = process.env.MOCCO_OTA_SIGNING_KEY;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  const local = path.join(projectDir, KEY_FILE);
  if (await isPresent(local)) {
    return await readFile(local, 'utf8');
  }
  throw new CliError(`No signing key: set MOCCO_OTA_SIGNING_KEY, pass --signing-key or run mocco-ota init`);
}

async function runInit(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      'manifest-url': { type: 'string' },
      channel: { type: 'string', default: 'production' },
      keyid: { type: 'string', default: DEFAULT_SIGNING_KEY_ID },
      project: { type: 'string', default: '.' },
    },
  });
  if (values['manifest-url'] === undefined) {
    throw new CliError('--manifest-url is required (copy it from the console)');
  }
  await init({
    projectDir: path.resolve(values.project),
    manifestUrl: values['manifest-url'],
    channel: values.channel,
    keyid: values.keyid,
    log,
  });
}

/** The API key from the environment, and the app and API base from app.json (or flags). */
async function targetOf(projectDir: string, flags: { 'app-id'?: string; 'api-url'?: string }) {
  const apiKey = process.env.MOCCO_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new CliError('Set MOCCO_API_KEY to a secret API key with the ota:write scope');
  }
  const { json } = await readAppJson(projectDir);
  const expo = json.expo ?? {};
  const fromUrl = expo.updates?.url === undefined ? undefined : parseManifestUrl(expo.updates.url);
  const appId = flags['app-id'] ?? fromUrl?.appId;
  const apiBase = flags['api-url'] ?? fromUrl?.apiBase;
  if (appId === undefined || apiBase === undefined) {
    throw new CliError('app.json has no Mocco updates.url; run mocco-ota init, or pass --app-id and --api-url');
  }
  return { apiKey, appId, apiBase, expo };
}

async function runPromote(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      release: { type: 'string' },
      channel: { type: 'string' },
      'app-id': { type: 'string' },
      'api-url': { type: 'string' },
      project: { type: 'string', default: '.' },
    },
  });
  if (values.release === undefined || values.channel === undefined) {
    throw new CliError('--release and --channel are required');
  }
  const { apiKey, appId, apiBase } = await targetOf(path.resolve(values.project), values);
  await promote({ apiBase, appId, apiKey, releaseId: values.release, channel: values.channel, log });
}

async function runPublish(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      platform: { type: 'string', default: 'all' },
      channel: { type: 'string' },
      message: { type: 'string' },
      mandatory: { type: 'boolean', default: false },
      'skip-export': { type: 'boolean', default: false },
      dist: { type: 'string', default: 'dist' },
      'runtime-version': { type: 'string' },
      'signing-key': { type: 'string' },
      'git-sha': { type: 'string' },
      'app-id': { type: 'string' },
      'api-url': { type: 'string' },
      project: { type: 'string', default: '.' },
    },
  });
  const projectDir = path.resolve(values.project);
  const { apiKey, appId, apiBase, expo } = await targetOf(projectDir, values);
  const platforms = platformsOf(values.platform);
  const [first = OtaPlatforms.ios] = platforms;
  const distDir = path.resolve(projectDir, values.dist);
  if (!values['skip-export']) {
    await expoExport(projectDir, values.platform, distDir);
  }
  const result = await publish({
    apiBase,
    appId,
    apiKey,
    distDir,
    platforms,
    runtimeVersion: values['runtime-version'] ?? runtimeVersionOf(expo, first),
    signingKeyPem: await signingKeyOf(projectDir, values['signing-key']),
    keyid: keyidOf(expo),
    message: values.message ?? (await gitOutput(projectDir, ['log', '-1', '--pretty=%s'])),
    gitSha: values['git-sha'] ?? process.env.GITHUB_SHA ?? (await gitOutput(projectDir, ['rev-parse', 'HEAD'])),
    isMandatory: values.mandatory,
    expoConfig: expo,
    log,
  });
  log(
    `Done: release ${result.releaseId} (${result.reusedAssets} asset(s) reused, ${result.uploadedBytes} bytes uploaded).`,
  );
  if (values.channel !== undefined) {
    log(`Waiting for Mocco to verify the assets before promoting to ${values.channel}…`);
    await promote({ apiBase, appId, apiKey, releaseId: result.releaseId, channel: values.channel, log });
  }
}

/** Run the command line; resolves to the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'init') {
      await runInit(rest);
      return 0;
    }
    if (command === 'publish') {
      await runPublish(rest);
      return 0;
    }
    if (command === 'promote') {
      await runPromote(rest);
      return 0;
    }
    process.stdout.write(USAGE);
    return command === undefined || ['help', '--help'].includes(command) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`mocco-ota: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
