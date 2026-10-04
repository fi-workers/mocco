---
title: Object storage
description: The neutral object-store port and its drivers, the mocco_objects ledger, two-phase uploads with per-product policy and a workspace quota, signed URLs for the filesystem driver, and the storage.gc job.
type: reference
status: active
created: 2026-10-01
updated: 2026-10-05
confidence: high
owner: andrea
tags: [reference, platform, storage, s3, r2]
related:
  - ../specs/2026-09-24-platform-foundations-design.md
  - ./env.md
  - ./jobs.md
code_refs:
  - packages/backend/src/domain/storage/StorageService.ts
  - packages/backend/src/domain/storage/ports.ts
  - packages/backend/src/domain/storage/drivers/s3.ts
  - packages/backend/src/domain/storage/drivers/filesystem.ts
  - packages/backend/src/domain/storage/config.ts
  - packages/backend/src/transport/ext/storage.ts
---

# Object storage

> Platform foundations §10 (#116). Products store files (OTA bundles and assets first, later messenger attachments and help-center images) through `StorageService`. The bytes live in the configured store; the `mocco_objects` ledger says who owns them, what they are, and whether the upload finished.

## Drivers

`ObjectStore` (`domain/storage/ports.ts`) has two drivers, chosen by `STORAGE_DRIVER`:

| Driver | For | How clients reach it |
|---|---|---|
| `s3` | Hosted and self-host: AWS S3, Cloudflare R2 (recommended: free egress), MinIO, Supabase Storage's S3 endpoint | Presigned URLs straight to the bucket |
| `filesystem` | Local dev, tests, single-box self-host | Signed URLs on `/api/ext/internal/storage/*` |

Unset, local dev uses `filesystem` (under `.mocco-storage/` in the working directory, gitignored) and a Vercel deploy has no store: its filesystem doesn't persist, so storage features report "not configured" until S3 or R2 is set. A Vercel Blob driver isn't included yet.

## Keys and visibility

Keys are `<pub|prv>/w/<workspace>/[p/<project>/]<product>/<object id>/<filename>`, with the filename reduced to lowercase letters, digits, dot, dash and underscore. Public objects (`pub/`) have a stable URL: `STORAGE_PUBLIC_BASE_URL` (a CDN in front of the bucket) for `s3`, or the unsigned route path for `filesystem`. Expose only the `pub/` prefix publicly. Private objects (`prv/`) are readable only through an expiring signed URL.

Status pages publish fixed files outside this ledger under `pub/status/<slug>/` (no workspace segment, because the CDN maps a page's host to that prefix; see [status pages](./status.md#public-page)). They go through the same `ObjectStore` with their own `Cache-Control`. The filesystem driver writes every object to a temporary file and renames it into place, so a static server over the directory never serves half a file.

## Uploads

Two-phase, so the bytes never pass through Mocco's functions:

1. `beginUpload` checks the product's policy (`policy.ts`: allowed content types and the largest object) and the workspace quota (pending plus ready bytes, 10 GiB by default), records a `pending` row and returns a presigned PUT target valid for 15 minutes.
2. The client uploads to that URL.
3. `completeUpload` checks the stored object with `head`. It must exist, be exactly the declared size and have the declared content type. Otherwise its bytes are deleted, the row becomes `deleted`, and `StorageUploadMismatchError` is thrown. A match makes the row `ready` and records a `storage_bytes` usage event (a no-op until usage metering lands).

`putObject` stores bytes the server already has and records them `ready` at once. A product without a policy entry can't store anything.

## The filesystem route

`GET /api/ext/internal/storage/<key>` serves a public object without a signature, and a private one only with a valid `op=get` signature that hasn't expired. A refused read is a 404, the same as a missing object, so keys can't be probed. `PUT` needs a valid `op=put` signature. The signature covers the key, the expiry, the content type, the size limit and the visibility, so a URL can't be reused for another key or changed to make the object public. The request's `content-type` must equal the signed one, and the body must fit the limit (`413` otherwise). Keys with `..` or other unsafe segments are refused. The HMAC key is `STORAGE_SIGNING_SECRET`, or one derived from `AUTH_SECRET`; a Vercel deploy without either can't build the filesystem driver.

## Garbage collection

`storage.gc` runs daily (registered only when a store is configured). It deletes the bytes of pending uploads older than 24 hours and marks them `deleted`, then drops the rows of objects deleted more than 7 days ago. It works in batches of 500, so a backlog drains over several runs.

## Errors

| Domain error | Base | tRPC code |
|---|---|---|
| `StorageProductNotAllowedError`, `StorageContentTypeNotAllowedError`, `StorageObjectTooLargeError`, `StorageQuotaExceededError`, `StorageUploadMismatchError`, `StorageUnavailableError` | `BadRequestError` | `BAD_REQUEST` |
| `StoredObjectNotFoundError` | `NotFoundError` | `NOT_FOUND` |
