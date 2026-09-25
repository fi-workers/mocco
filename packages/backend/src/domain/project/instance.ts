// Production composition root for the project domain (ADR 0013). Lazy so builds don't
// need env at import. No external dependency — always available, like governance.
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { ProductEnablementService } from '@backend/domain/project/ProductEnablementService';
import { ProjectService } from '@backend/domain/project/ProjectService';
import { ProjectAppRepo } from '@backend/domain/project/repos/project-app.repo';
import { ProjectRepoRepo } from '@backend/domain/project/repos/project-repo.repo';
import { ProjectRepo } from '@backend/domain/project/repos/project.repo';
import { WorkspaceProductRepo } from '@backend/domain/project/repos/workspace-product.repo';
import { getDb } from '@backend/infra/db/client';

import type { Db } from '@backend/infra/db/types';

export interface ProjectDomain {
  projects: ProjectService;
  products: ProductEnablementService;
}

/** Build the project services over a db. The production root below binds it once;
 * tests call it with a pglite db — same classes, same wiring. */
export function createProjectDomain(db: Db): ProjectDomain {
  return {
    projects: new ProjectService({
      projects: new ProjectRepo(db),
      apps: new ProjectAppRepo(db),
      projectRepos: new ProjectRepoRepo(db),
      repos: new RepoRepo(db),
    }),
    products: new ProductEnablementService({ workspaceProducts: new WorkspaceProductRepo(db) }),
  };
}

const state: { project?: ProjectDomain } = {};

/** The project services. Always available (no external dependency to gate on). */
export function getProjectDomain(): ProjectDomain {
  state.project ??= createProjectDomain(getDb());
  return state.project;
}
