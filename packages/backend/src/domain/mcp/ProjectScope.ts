// Which project a tool call acts in, for the products that scope their data to one.
//
// The same checks the console's `productProcedure` makes: the caller must be a member of
// the workspace (re-checked on every call by `WorkspaceScope`), the product must be
// enabled there, and the project must belong to that workspace. A project id in a tool
// call grants nothing by itself — it is only ever looked up inside a workspace the caller
// belongs to, so a foreign project reads exactly like an unknown one, and a non-member is
// refused before any project is looked up at all.
//
// Like the workspace, the project may be left out when there is exactly one; otherwise
// the refusal names the choices.
import { ProjectUnclearError } from '@backend/domain/mcp/errors';

import type { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import type { ProductEnablementService } from '@backend/domain/project/ProductEnablementService';
import type { ProjectService } from '@backend/domain/project/ProjectService';
import type { Product } from '@mocco/common/project';

export interface ProjectScopeDeps {
  workspaces: WorkspaceScope;
  projects: Pick<ProjectService, 'list' | 'requireProject'>;
  products: Pick<ProductEnablementService, 'assertEnabled'>;
}

export interface ProjectInScope {
  workspaceId: string;
  projectId: string;
}

export class ProjectScope {
  constructor(private readonly deps: ProjectScopeDeps) {}

  /**
   * The workspace and project this call acts in, for `product`. Throws
   * `WorkspaceNotAllowedError` / `WorkspaceUnclearError` for the workspace,
   * `ProductNotEnabledError` when the product is off there, `ProjectNotFoundError` for a
   * project outside it, and `ProjectUnclearError` naming the choices when none was named
   * and the workspace does not have exactly one.
   */
  async resolve(
    userId: string,
    asked: { workspaceId?: string; projectId?: string },
    product: Product,
  ): Promise<ProjectInScope> {
    const workspaceId = await this.deps.workspaces.resolve(userId, asked.workspaceId);
    await this.deps.products.assertEnabled(workspaceId, product);
    if (asked.projectId !== undefined) {
      const project = await this.deps.projects.requireProject(workspaceId, asked.projectId);
      return { workspaceId, projectId: project.id };
    }
    const projects = await this.deps.projects.list(workspaceId, { includeArchived: false });
    const [only] = projects;
    if (projects.length !== 1 || only === undefined) {
      throw new ProjectUnclearError(projects.map(each => ({ id: each.id, name: each.name })));
    }
    return { workspaceId, projectId: only.id };
  }
}
