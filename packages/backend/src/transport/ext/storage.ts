// The filesystem storage driver's internal route, mounted on the ext app under /api/ext.
// It has no session: a GET is served with a valid signed `op=get` URL, or without one
// only for an object whose sidecar says it is public; a PUT needs a signed `op=put` URL
// and must match the signed content type, size limit and visibility. With the s3 driver
// clients talk to the bucket directly and this route answers 404.
import { visibilitySchema } from '@mocco/common/storage';
import { Hono } from 'hono';

import { isPublic, isSafeKey } from '@backend/domain/storage/drivers/filesystem';
import { StorageOperations } from '@backend/domain/storage/signing';

import type { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import type { StorageUrlSigner } from '@backend/domain/storage/signing';

export const STORAGE_ROUTE = '/internal/storage';

export interface StorageRouteDeps {
  store: FilesystemObjectStore;
  signer: StorageUrlSigner;
  now?: () => Date;
}

/** The object key after the route prefix, decoded per segment; null when it isn't a safe key. */
function keyFromPath(requestPath: string): string | null {
  const marker = `${STORAGE_ROUTE}/`;
  // eslint-disable-next-line sonarjs/null-dereference -- requestPath is a string, never null
  const at = requestPath.indexOf(marker);
  if (at === -1) {
    return null;
  }
  try {
    const key = requestPath
      .slice(at + marker.length)
      .split('/')
      .map(segment => decodeURIComponent(segment))
      .join('/');
    return isSafeKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** `deps` undefined (not the filesystem driver) → every request 404s. */
export function createStorageRoutes(deps: StorageRouteDeps | undefined): Hono {
  const app = new Hono();
  const nowSeconds = () => Math.floor((deps?.now?.() ?? new Date()).getTime() / 1000);

  app.get(`${STORAGE_ROUTE}/*`, async c => {
    const key = deps === undefined ? null : keyFromPath(c.req.path);
    if (deps === undefined || key === null) {
      return c.text('not found', 404);
    }
    const signature = c.req.query('sig');
    const meta = await deps.store.meta(key);
    const isAllowed =
      signature === undefined
        ? isPublic(meta)
        : deps.signer.isValid(
            { op: StorageOperations.get, key, expires: Number(c.req.query('exp')) },
            signature,
            nowSeconds(),
          );
    // A refused read and a missing object look the same, so keys can't be probed.
    const body = isAllowed && meta !== null ? await deps.store.get(key) : null;
    if (meta === null || body === null) {
      return c.text('not found', 404);
    }
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': meta.contentType,
        'content-length': String(meta.size),
        etag: `"${meta.etag}"`,
        'cache-control': meta.cacheControl ?? (signature === undefined ? 'public, max-age=300' : 'private, no-store'),
      },
    });
  });

  app.put(`${STORAGE_ROUTE}/*`, async c => {
    const key = deps === undefined ? null : keyFromPath(c.req.path);
    if (deps === undefined || key === null) {
      return c.text('not found', 404);
    }
    const contentType = c.req.query('ct') ?? '';
    const maxBytes = Number(c.req.query('max'));
    const visibility = visibilitySchema.safeParse(c.req.query('vis'));
    const isSigned =
      visibility.success &&
      deps.signer.isValid(
        {
          op: StorageOperations.put,
          key,
          expires: Number(c.req.query('exp')),
          contentType,
          maxBytes,
          visibility: visibility.data,
        },
        c.req.query('sig') ?? '',
        nowSeconds(),
      );
    if (!isSigned || !visibility.success) {
      return c.text('forbidden', 403);
    }
    if (c.req.header('content-type') !== contentType) {
      return c.text('content type does not match the upload URL', 400);
    }
    const declaredLength = Number(c.req.header('content-length') ?? NaN);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return c.text('too large', 413);
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxBytes) {
      return c.text('too large', 413);
    }
    const { etag } = await deps.store.put(key, body, { contentType, visibility: visibility.data });
    return c.body(null, 200, { etag: `"${etag}"` });
  });

  return app;
}
