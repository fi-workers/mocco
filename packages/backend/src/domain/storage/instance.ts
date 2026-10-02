// Production composition root for object storage. Lazy so builds don't need env at
// import. The driver comes from STORAGE_DRIVER; unset, local dev gets the filesystem
// driver and a Vercel deploy gets none (its filesystem doesn't persist), so storage
// features report "not configured" there until S3/R2 is set.
import { createObjectStoreFromEnv } from '@backend/domain/storage/config';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageService } from '@backend/domain/storage/StorageService';
import { getEnv } from '@backend/infra/config/env';
import { getDb } from '@backend/infra/db/client';

import type { ObjectStore } from '@backend/domain/storage/ports';
import type { Db } from '@backend/infra/db/types';

export interface StorageDomain {
  storage: StorageService;
  store: ObjectStore;
}

export function createStorageDomain(db: Db, store: ObjectStore): StorageDomain {
  return { storage: new StorageService({ objects: new ObjectRepo(db), store }), store };
}

const state: { storage?: StorageDomain | null } = {};

/** The storage services, or undefined when no store is configured. */
export function getStorageDomain(): StorageDomain | undefined {
  if (state.storage === undefined) {
    const store = createObjectStoreFromEnv(getEnv());
    state.storage = store === undefined ? null : createStorageDomain(getDb(), store);
  }
  return state.storage ?? undefined;
}
