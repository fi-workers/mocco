import { and, asc, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';
import type { Product } from '@mocco/common/project';

/** Data access for mocco_workspace_products. Every query is scoped by `workspace_id`. */
export class WorkspaceProductRepo {
  constructor(private readonly db: Db) {}

  /** Turn a product on; idempotent — a repeat enable keeps the original row. */
  async enable(row: typeof schema.workspaceProducts.$inferInsert) {
    await this.db.insert(schema.workspaceProducts).values(row).onConflictDoNothing();
  }

  /** Turn a product off; a missing row is a no-op. */
  async disable(workspaceId: string, product: Product) {
    await this.db
      .delete(schema.workspaceProducts)
      .where(and(eq(schema.workspaceProducts.workspaceId, workspaceId), eq(schema.workspaceProducts.product, product)));
  }

  /** The stored enablement row for a product, if any. */
  async find(workspaceId: string, product: Product) {
    const [row] = await this.db
      .select()
      .from(schema.workspaceProducts)
      .where(and(eq(schema.workspaceProducts.workspaceId, workspaceId), eq(schema.workspaceProducts.product, product)));
    return row;
  }

  /** A workspace's stored enablements, oldest first. */
  async listByWorkspace(workspaceId: string) {
    return await this.db
      .select()
      .from(schema.workspaceProducts)
      .where(eq(schema.workspaceProducts.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceProducts.enabledAt));
  }
}
