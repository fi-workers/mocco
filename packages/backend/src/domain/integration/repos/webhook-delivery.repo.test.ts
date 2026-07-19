import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

describe('WebhookDeliveryRepo (pglite)', () => {
  let t: TestDb;
  let webhookDeliveryRepo: WebhookDeliveryRepo;

  beforeEach(async () => {
    t = await createTestDb();
    webhookDeliveryRepo = new WebhookDeliveryRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  it('returns true the first time a delivery id is recorded, false on redelivery', async () => {
    const deliveryId = randomUUID();
    expect(await webhookDeliveryRepo.recordIfNew('github', deliveryId, 'push')).toBe(true);
    expect(await webhookDeliveryRepo.recordIfNew('github', deliveryId, 'push')).toBe(false);
  });

  it('treats distinct delivery ids as distinct — both win', async () => {
    expect(await webhookDeliveryRepo.recordIfNew('github', randomUUID(), 'push')).toBe(true);
    expect(await webhookDeliveryRepo.recordIfNew('github', randomUUID(), 'push')).toBe(true);
  });
});
