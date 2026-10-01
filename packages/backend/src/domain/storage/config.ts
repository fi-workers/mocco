// Builds the object store and the filesystem driver's URL signer from env. Pure (no db,
// no instance state), so both the storage composition root and runtime/jobs.ts use it.
import { createHash } from 'node:crypto';
import path from 'node:path';

import { resolveBaseOrigin } from '@backend/domain/execution/endpoints';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { S3ObjectStore } from '@backend/domain/storage/drivers/s3';
import { StorageUrlSigner } from '@backend/domain/storage/signing';

import type { ObjectStore } from '@backend/domain/storage/ports';
import type { Env } from '@backend/infra/config/env';

/** Where the filesystem driver's internal route is mounted (transport/ext/storage.ts). */
export const STORAGE_ROUTE_PATH = '/api/ext/internal/storage';

const LOCAL_SIGNING_SECRET = 'mocco-local-storage-signing-key';

/** The filesystem driver's URL signer. On Vercel it needs a real secret. */
export function storageSignerFromEnv(env: Env): StorageUrlSigner {
  if (env.STORAGE_SIGNING_SECRET !== undefined) {
    return new StorageUrlSigner(env.STORAGE_SIGNING_SECRET);
  }
  if (env.AUTH_SECRET !== undefined) {
    return new StorageUrlSigner(createHash('sha256').update(`mocco-storage:${env.AUTH_SECRET}`).digest('hex'));
  }
  if (env.VERCEL_ENV !== undefined) {
    throw new Error('STORAGE_SIGNING_SECRET or AUTH_SECRET is required for the filesystem storage driver');
  }
  return new StorageUrlSigner(LOCAL_SIGNING_SECRET);
}

/** The configured object store, or undefined when this deployment has none.
 *
 * sonarjs/function-return-type is a false positive here: every branch returns the
 * declared `ObjectStore | undefined` (two drivers implement the same port). */
// eslint-disable-next-line sonarjs/function-return-type
export function createObjectStoreFromEnv(env: Env): ObjectStore | undefined {
  const driver = env.STORAGE_DRIVER ?? (env.VERCEL_ENV === undefined ? 'filesystem' : undefined);
  if (driver === 's3') {
    const { STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY } = env;
    if (
      STORAGE_BUCKET === undefined ||
      STORAGE_ACCESS_KEY_ID === undefined ||
      STORAGE_SECRET_ACCESS_KEY === undefined
    ) {
      throw new Error('STORAGE_DRIVER=s3 needs STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY');
    }
    return new S3ObjectStore({
      bucket: STORAGE_BUCKET,
      region: env.STORAGE_REGION,
      accessKeyId: STORAGE_ACCESS_KEY_ID,
      secretAccessKey: STORAGE_SECRET_ACCESS_KEY,
      ...(env.STORAGE_ENDPOINT !== undefined && { endpoint: env.STORAGE_ENDPOINT }),
      ...(env.STORAGE_PUBLIC_BASE_URL !== undefined && { publicBaseUrl: env.STORAGE_PUBLIC_BASE_URL }),
    });
  }
  if (driver === 'filesystem') {
    const origin = resolveBaseOrigin({ serviceDomain: env.SERVICE_DOMAIN, vercelUrl: env.VERCEL_URL });
    return new FilesystemObjectStore({
      root: env.STORAGE_FS_ROOT ?? path.resolve(process.cwd(), '.mocco-storage'),
      baseUrl: `${origin}${STORAGE_ROUTE_PATH}`,
      signer: storageSignerFromEnv(env),
    });
  }
  return undefined;
}
