import { randomUUID } from 'node:crypto';

import { Products } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProductAlwaysEnabledError, ProductNotEnabledError } from '@backend/domain/project/errors';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { users, workspaceProducts, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { ProductEnablementService } from '@backend/domain/project/ProductEnablementService';

describe('ProductEnablementService (pglite)', () => {
  let t: TestDb;
  let service: ProductEnablementService;
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    t = await createTestDb();
    service = createProjectDomain(t.db).products;
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com`, name: 'Ada' })
        .returning(),
    ).id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('treats governance as enabled with no row, and lists it first', async () => {
    expect(await service.isEnabled(workspaceId, Products.governance)).toBe(true);
    expect(await service.list(workspaceId)).toEqual([Products.governance]);
    await expect(service.assertEnabled(workspaceId, Products.governance)).resolves.toBeUndefined();
  });

  it('enables and disables a product idempotently', async () => {
    expect(await service.isEnabled(workspaceId, Products.ota)).toBe(false);

    await service.enable(workspaceId, Products.ota, userId);
    await service.enable(workspaceId, Products.ota, userId);
    expect(await service.isEnabled(workspaceId, Products.ota)).toBe(true);
    expect(await service.list(workspaceId)).toEqual([Products.governance, Products.ota]);

    await service.disable(workspaceId, Products.ota);
    await service.disable(workspaceId, Products.ota);
    expect(await service.isEnabled(workspaceId, Products.ota)).toBe(false);
  });

  it('scopes enablement to the workspace', async () => {
    const otherId = expectOne(await t.db.insert(workspaces).values({ name: 'O', slug: randomUUID() }).returning()).id;
    await service.enable(workspaceId, Products.flags, userId);
    expect(await service.isEnabled(otherId, Products.flags)).toBe(false);
  });

  it('refuses to disable governance and ignores enabling it', async () => {
    await expect(service.disable(workspaceId, Products.governance)).rejects.toBeInstanceOf(ProductAlwaysEnabledError);
    await service.enable(workspaceId, Products.governance, userId);
    expect(await t.db.select().from(workspaceProducts)).toHaveLength(0);
  });

  it('assertEnabled throws ProductNotEnabledError for a product that is off', async () => {
    await expect(service.assertEnabled(workspaceId, Products.status)).rejects.toBeInstanceOf(ProductNotEnabledError);
  });

  it('the DB check accepts every non-governance product and rejects governance or unknown values', async () => {
    const stored = Object.values(Products).filter(value => value !== Products.governance);
    await t.db.insert(workspaceProducts).values(stored.map(product => ({ workspaceId, product })));
    await expect(
      t.db.insert(workspaceProducts).values({ workspaceId, product: Products.governance }),
    ).rejects.toThrow();
    await expect(
      t.db.execute(`insert into mocco_workspace_products (workspace_id, product) values ('${workspaceId}', 'nope')`),
    ).rejects.toThrow();
  });
});
