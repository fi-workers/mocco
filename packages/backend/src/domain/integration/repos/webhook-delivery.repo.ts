import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { Provider } from '@mocco/common/integration';

/** Data access for mocco_webhook_deliveries — recorded to dedupe redeliveries by delivery_id. */
export class WebhookDeliveryRepo {
  constructor(private readonly db: Db) {}

  /** Record a delivery id; `true` if this is the first time it's been seen (the
   * insert won), `false` if it's a redelivery (the unique constraint was hit). */
  async recordIfNew(provider: Provider, deliveryId: string, eventType: string): Promise<boolean> {
    const rows = await this.db
      .insert(schema.webhookDeliveries)
      .values({ provider, deliveryId, eventType })
      .onConflictDoNothing({ target: schema.webhookDeliveries.deliveryId })
      .returning();
    return rows.length > 0;
  }
}
