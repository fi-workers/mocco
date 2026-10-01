// `mocco-ota publish`: export (optionally), hash, upload only what Mocco lacks, sign
// every body a device will verify, and finalize (OTA design §6.3).
import { randomUUID } from 'node:crypto';

import { MoccoApi } from './api';
import { readExport } from './expo-export';
import { buildManifest, republishOf, rollBackToEmbeddedOf } from './manifest';
import { promoteWithSession } from './promote';
import { signBody } from './sign';

import type { FinalizeResult } from './api';
import type { ExportedFile, PlatformExport } from './expo-export';
import type { FinalizeRequest, OtaPlatform } from '@mocco/common/ota-hosting';

export interface PublishOptions {
  apiBase: string;
  appId: string;
  /** A secret API key with ota:write, or a GitHub Actions OIDC token (trusted publishing). */
  auth: { apiKey: string } | { oidcToken: string };
  distDir: string;
  platforms: readonly OtaPlatform[];
  runtimeVersion: string;
  signingKeyPem: string;
  keyid: string;
  message: string | null;
  gitSha: string | null;
  isMandatory: boolean;
  /** The static Expo config, served to the app as `extra.expoClient`. */
  expoConfig: Record<string, unknown>;
  /** Promote to this channel once Mocco has verified the release (a protected one asks for approval). */
  channel?: string;
  /** On a protected channel, wait for the approval (the session must still be valid). */
  isWaitingForApproval?: boolean;
  log?: (line: string) => void;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface PublishResult extends FinalizeResult {
  uploadedBytes: number;
  reusedAssets: number;
}

/** Upload at most this many assets at once. */
const UPLOAD_CONCURRENCY = 6;

const filesOf = (exported: PlatformExport) => [exported.bundle, ...exported.assets];

/** The first file per hash across every platform. */
function uniqueFiles(exports: readonly PlatformExport[]): ExportedFile[] {
  const files = exports.flatMap(exported => filesOf(exported));
  return files.filter((file, index) => files.findIndex(other => other.hash === file.hash) === index);
}

/** Run `task` over `items`, `limit` at a time. */
async function inBatches<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const batches = Array.from({ length: Math.ceil(items.length / limit) }, (_, index) =>
    items.slice(index * limit, (index + 1) * limit),
  );
  await batches.reduce(async (previous, batch) => {
    await previous;
    await Promise.all(batch.map(async item => await task(item)));
  }, Promise.resolve());
}

export async function publish(options: PublishOptions): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => new Date());
  const api = new MoccoApi(options.apiBase, options.fetch);
  const exports = await readExport(options.distDir, options.platforms);
  const files = uniqueFiles(exports);

  const session =
    'apiKey' in options.auth
      ? await api.createSession(options.appId, options.auth.apiKey)
      : await api.exchangeOidc(options.appId, options.auth.oidcToken);
  const declared = await api.declare(session, {
    runtimeVersion: options.runtimeVersion,
    platforms: [...options.platforms],
    assets: files.map(file => ({
      hash: file.hash,
      size: file.bytes.byteLength,
      contentType: file.contentType,
      ext: file.ext,
    })),
    gitSha: options.gitSha,
    message: options.message,
    mandatory: options.isMandatory,
  });
  const byHash = new Map(files.map(file => [file.hash, file]));
  const uploadedBytes = declared.missing.reduce(
    (sum, target) => sum + (byHash.get(target.hash)?.bytes.byteLength ?? 0),
    0,
  );
  log(
    `Release ${declared.releaseId}: uploading ${declared.missing.length} of ${files.length} assets (${uploadedBytes} bytes)`,
  );
  await inBatches(declared.missing, UPLOAD_CONCURRENCY, async target => {
    const file = byHash.get(target.hash);
    if (file === undefined) {
      throw new Error(`Mocco asked for asset ${target.hash}, which this export doesn't have`);
    }
    await api.put(target, file.bytes);
  });

  const sign = (body: string) => signBody(body, options.signingKeyPem, options.keyid);
  const signed = exports.map(exported => {
    const createdAt = now();
    const body = buildManifest({
      id: randomUUID(),
      createdAt,
      runtimeVersion: options.runtimeVersion,
      assetBaseUrl: declared.assetBaseUrl,
      exported,
      extra: {
        expoClient: options.expoConfig,
        mocco: { releaseId: declared.releaseId, mandatory: options.isMandatory, gitSha: options.gitSha },
      },
    });
    return { platform: exported.platform, body, createdAt };
  });
  const later = (platform: OtaPlatform) =>
    new Date((signed.find(update => update.platform === platform)?.createdAt ?? now()).getTime() + 1);
  const request: FinalizeRequest = {
    updates: signed.map(update => ({ platform: update.platform, body: update.body, signature: sign(update.body) })),
    republishes: declared.rollbackTargets.map(target => {
      const body = republishOf(target.manifest, randomUUID(), later(target.platform));
      return { platform: target.platform, targetUpdateId: target.updateId, body, signature: sign(body) };
    }),
    directives: signed.map(update => {
      const body = rollBackToEmbeddedOf(later(update.platform));
      return { platform: update.platform, body, signature: sign(body) };
    }),
  };
  const result = await api.finalize(session, declared.releaseId, request);
  log(
    `Finalized: ${Object.entries(result.updates)
      .map(([platform, id]) => `${platform} ${id}`)
      .join(', ')}; ${request.republishes.length} rollback(s) pre-signed. Mocco is verifying the assets.`,
  );
  if (options.channel !== undefined) {
    log(`Waiting for Mocco to verify the assets before promoting to ${options.channel}…`);
    await promoteWithSession(
      api,
      { session, releaseId: result.releaseId, channel: options.channel },
      { log, isWaitingForApproval: options.isWaitingForApproval === true },
    );
  }
  return { ...result, uploadedBytes, reusedAssets: files.length - declared.missing.length };
}
