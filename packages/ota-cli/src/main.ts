// The `mocco-ota` command line: argument parsing, environment and process glue around
// `init` and `publish`. Errors print one line saying what to fix and exit 1.
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

import { DEFAULT_SIGNING_KEY_ID, OtaPlatforms } from '@mocco/common/ota-hosting';

import { MoccoApi } from './api';
import { isFingerprintPolicy, keyidOf, parseManifestUrl, readAppJson, runtimeVersionOf } from './app-config';
import { CliError } from './errors';
import { exportCommandOf } from './expo-export';
import { fingerprintOf } from './fingerprint';
import { isPresent } from './fs';
import { init, KEY_FILE } from './init';
import { promote } from './promote';
import { publish } from './publish';
import { releaseGroupsOf } from './release-groups';

import type { ExpoConfig } from './app-config';
import type { OtaPlatform } from '@mocco/common/ota-hosting';

const USAGE = `Usage:
  mocco-ota init --manifest-url <url> [--channel production] [--keyid root] [--keep-key] [--project .]
      Make the signing key and certificate, and point app.json at Mocco.
      Copy the manifest URL from the console (OTA hosting → Connect the app).
      --keep-key reuses the key and certificate already in the project and writes only
      the config — for pointing at another Mocco app without a new store build.

  mocco-ota publish [--channel <name> [--rollout <percent>] [--wait]] [--oidc] [--platform ios|android|all] [--message <text>]
                    [--mandatory] [--skip-export] [--dist dist] [--runtime-version <v>]
                    [--signing-key <file>] [--git-sha <sha>] [--project .]
      Export, upload and finalize a signed release; with --channel, promote it once ready
      (--wait waits for approval on a protected channel, within the 15-minute session).
      The runtime version comes from --runtime-version, else app.json: a literal, the
      appVersion policy, or the fingerprint policy (resolved per platform by the project's
      own Expo CLI, which makes iOS and Android separate releases).
      Authenticates with MOCCO_API_KEY (a secret key with ota:write), or with --oidc in
      GitHub Actions (trusted publishing; the default there when MOCCO_API_KEY is unset).
      Signs with MOCCO_OTA_SIGNING_KEY, --signing-key or ${KEY_FILE}.

  mocco-ota promote --release <id> --channel <name> [--rollout <percent>] [--wait]
      Point a channel at a ready release, or roll it out to a share of devices; a
      protected channel gets an approval request (--wait waits for the decision).

  mocco-ota pause --channel <name>
  mocco-ota rollback --channel <name> [--platform ios|android] [--to-embedded]
      Stop a rollout, or roll back instantly to the pre-signed republish (or to the
      embedded bundle). Never gated. Both need MOCCO_API_KEY.
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

/** Run `expo export` for `platforms` (the command itself is `exportCommandOf`). */
async function expoExport(projectDir: string, platforms: readonly OtaPlatform[], distDir: string): Promise<void> {
  const { command, args } = exportCommandOf(platforms, distDir);
  log(`Running ${command} ${args.join(' ')}…`);
  const child = spawn(command, args, { cwd: projectDir, stdio: 'inherit' });
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
      'keep-key': { type: 'boolean', default: false },
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
    isKeepingKey: values['keep-key'],
    log,
  });
}

/** The API key from the environment, and the app and API base from app.json (or flags). */
/** The secret API key from MOCCO_API_KEY, or a CliError saying how to set it. */
function apiKeyOf(): string {
  const apiKey = process.env.MOCCO_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new CliError(
      'Set MOCCO_API_KEY to a secret API key with the ota:write scope (or use --oidc in GitHub Actions)',
    );
  }
  return apiKey;
}

/** The job's OIDC token for Mocco (GitHub Actions with `permissions: id-token: write`). */
async function githubOidcToken(apiBase: string): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (url === undefined || bearer === undefined) {
    throw new CliError('--oidc needs GitHub Actions with `permissions: id-token: write`');
  }
  const audience = new URL(apiBase).origin;
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `bearer ${bearer}` },
  });
  if (!response.ok) {
    throw new CliError(`GitHub refused the OIDC token request (${response.status})`);
  }
  const { value } = (await response.json()) as { value: string };
  return value;
}

/** Trusted publishing when asked, or when running in Actions without a key. */
function isOidcWanted(isAsked: boolean): boolean {
  const apiKey = process.env.MOCCO_API_KEY;
  return isAsked || ((apiKey === undefined || apiKey === '') && process.env.ACTIONS_ID_TOKEN_REQUEST_URL !== undefined);
}

async function targetOf(projectDir: string, flags: { 'app-id'?: string; 'api-url'?: string }) {
  const { json } = await readAppJson(projectDir);
  const expo = json.expo ?? {};
  const fromUrl = expo.updates?.url === undefined ? undefined : parseManifestUrl(expo.updates.url);
  const appId = flags['app-id'] ?? fromUrl?.appId;
  const apiBase = flags['api-url'] ?? fromUrl?.apiBase;
  if (appId === undefined || apiBase === undefined) {
    throw new CliError('app.json has no Mocco updates.url; run mocco-ota init, or pass --app-id and --api-url');
  }
  return { appId, apiBase, expo };
}

/** What one platform publishes under: the flag wins, then app.json — where only the
 * project's own Expo CLI can resolve the `fingerprint` policy. */
function runtimeVersionResolver(projectDir: string, expo: ExpoConfig, flag: string | undefined) {
  return async (platform: OtaPlatform): Promise<string> => {
    if (flag !== undefined) {
      return flag;
    }
    return isFingerprintPolicy(expo) ? await fingerprintOf(projectDir, platform) : runtimeVersionOf(expo, platform);
  };
}

/** `--rollout 10` → 10 (percent); unset → 100. */
function percentOf(value: string | undefined): number {
  if (value === undefined) {
    return 100;
  }
  // eslint-disable-next-line sonarjs/null-dereference -- narrowed to a string above
  const percent = Number(value.replace(/%$/u, ''));
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new CliError(`--rollout must be a percent between 0 and 100 (got ${value})`);
  }
  return percent;
}

/** `mocco-ota pause|rollback --channel <name> [--to-embedded]`: stop actions, never gated. */
async function runStop(command: 'pause' | 'rollback', args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      channel: { type: 'string' },
      platform: { type: 'string' },
      'to-embedded': { type: 'boolean', default: false },
      'app-id': { type: 'string' },
      'api-url': { type: 'string' },
      project: { type: 'string', default: '.' },
    },
  });
  if (values.channel === undefined) {
    throw new CliError('--channel is required');
  }
  const { appId, apiBase } = await targetOf(path.resolve(values.project), values);
  const rollbackAction = values['to-embedded'] ? 'rollback-to-embedded' : 'rollback';
  const action = command === 'pause' ? 'pause' : rollbackAction;
  const result = await new MoccoApi(apiBase).stop(appId, values.channel, action, apiKeyOf(), values.platform ?? null);
  log(`${result.channel}: ${result.kind.replace('_', ' ')} done (${result.platforms.join(', ')}).`);
}

async function runPromote(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      release: { type: 'string' },
      channel: { type: 'string' },
      rollout: { type: 'string' },
      wait: { type: 'boolean', default: false },
      'app-id': { type: 'string' },
      'api-url': { type: 'string' },
      project: { type: 'string', default: '.' },
    },
  });
  if (values.release === undefined || values.channel === undefined) {
    throw new CliError('--release and --channel are required');
  }
  const { appId, apiBase } = await targetOf(path.resolve(values.project), values);
  await promote({
    apiBase,
    appId,
    apiKey: apiKeyOf(),
    releaseId: values.release,
    channel: values.channel,
    rolloutPercent: percentOf(values.rollout),
    isWaitingForApproval: values.wait,
    log,
  });
}

async function runPublish(args: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      platform: { type: 'string', default: 'all' },
      channel: { type: 'string' },
      rollout: { type: 'string' },
      wait: { type: 'boolean', default: false },
      oidc: { type: 'boolean', default: false },
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
  const { appId, apiBase, expo } = await targetOf(projectDir, values);
  const auth = isOidcWanted(values.oidc) ? { oidcToken: await githubOidcToken(apiBase) } : { apiKey: apiKeyOf() };
  const platforms = platformsOf(values.platform);
  const distDir = path.resolve(projectDir, values.dist);
  if (!values['skip-export']) {
    await expoExport(projectDir, platforms, distDir);
  }
  const groups = await releaseGroupsOf(platforms, runtimeVersionResolver(projectDir, expo, values['runtime-version']));
  const common = {
    apiBase,
    appId,
    auth,
    distDir,
    signingKeyPem: await signingKeyOf(projectDir, values['signing-key']),
    keyid: keyidOf(expo),
    message: values.message ?? (await gitOutput(projectDir, ['log', '-1', '--pretty=%s'])),
    gitSha: values['git-sha'] ?? process.env.GITHUB_SHA ?? (await gitOutput(projectDir, ['rev-parse', 'HEAD'])),
    isMandatory: values.mandatory,
    expoConfig: expo,
    ...(values.channel !== undefined && {
      channel: values.channel,
      isWaitingForApproval: values.wait,
      rolloutPercent: percentOf(values.rollout),
    }),
    log,
  };
  // Sequential: a second release reuses the assets the first one just uploaded.
  await groups.reduce(async (previous, group) => {
    await previous;
    if (groups.length > 1) {
      log(`Publishing ${group.platforms.join(', ')} under runtime version ${group.runtimeVersion}…`);
    }
    const result = await publish({ ...common, platforms: group.platforms, runtimeVersion: group.runtimeVersion });
    log(
      `Done: release ${result.releaseId} (${result.reusedAssets} asset(s) reused, ${result.uploadedBytes} bytes uploaded).`,
    );
  }, Promise.resolve());
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
    if (command === 'pause' || command === 'rollback') {
      await runStop(command, rest);
      return 0;
    }
    process.stdout.write(USAGE);
    return command === undefined || ['help', '--help'].includes(command) ? 0 : 1;
  } catch (error) {
    process.stderr.write(`mocco-ota: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
