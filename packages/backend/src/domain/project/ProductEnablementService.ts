import { Products } from '@mocco/common/project';

import { ProductAlwaysEnabledError, ProductNotEnabledError } from '@backend/domain/project/errors';

import type { WorkspaceProductRepo } from '@backend/domain/project/repos/workspace-product.repo';
import type { Product } from '@mocco/common/project';

export interface ProductEnablementServiceDeps {
  workspaceProducts: WorkspaceProductRepo;
}

/**
 * Which products a workspace has turned on (ADR 0013). Enablement is per workspace
 * because billing lives there. Deploy governance is implicitly enabled with no row,
 * so every existing workspace keeps working; it can't be disabled. Enable/disable
 * are idempotent.
 */
export class ProductEnablementService {
  constructor(private readonly deps: ProductEnablementServiceDeps) {}

  /** Turn a product on (no-op when already on, or for governance). */
  async enable(workspaceId: string, product: Product, enabledByUserId: string): Promise<void> {
    if (product === Products.governance) {
      return;
    }
    await this.deps.workspaceProducts.enable({ workspaceId, product, enabledByUserId });
  }

  /** Turn a product off (no-op when already off). Throws ProductAlwaysEnabledError for governance. */
  async disable(workspaceId: string, product: Product): Promise<void> {
    if (product === Products.governance) {
      throw new ProductAlwaysEnabledError(product);
    }
    await this.deps.workspaceProducts.disable(workspaceId, product);
  }

  /** Whether the workspace has the product on. Governance is always on. */
  async isEnabled(workspaceId: string, product: Product): Promise<boolean> {
    if (product === Products.governance) {
      return true;
    }
    return (await this.deps.workspaceProducts.find(workspaceId, product)) !== undefined;
  }

  /** Throw ProductNotEnabledError unless the workspace has the product on. */
  async assertEnabled(workspaceId: string, product: Product): Promise<void> {
    if (!(await this.isEnabled(workspaceId, product))) {
      throw new ProductNotEnabledError(product);
    }
  }

  /** The workspace's enabled products, governance first. */
  async list(workspaceId: string): Promise<Product[]> {
    const rows = await this.deps.workspaceProducts.listByWorkspace(workspaceId);
    return [Products.governance, ...rows.map(row => row.product)];
  }
}
