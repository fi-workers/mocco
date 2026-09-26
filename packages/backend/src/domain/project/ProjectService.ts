import {
  ProjectAppBundleTakenError,
  ProjectAppNotFoundError,
  ProjectArchivedError,
  ProjectHandleTakenError,
  ProjectNotFoundError,
  ProjectRepoNotFoundError,
} from '@backend/domain/project/errors';
import { EntityNotFoundError, UniqueConstraintError } from '@backend/infra/db/errors';

import type { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import type { ProjectAppRepo } from '@backend/domain/project/repos/project-app.repo';
import type { ProjectRepoRepo } from '@backend/domain/project/repos/project-repo.repo';
import type { ProjectRepo } from '@backend/domain/project/repos/project.repo';
import type { ProjectAppCreateInput, ProjectCreateInput } from '@mocco/common/project';

export interface ProjectServiceDeps {
  projects: ProjectRepo;
  apps: ProjectAppRepo;
  projectRepos: ProjectRepoRepo;
  /** The integration domain's repo table — to prove a repo is the workspace's before linking. */
  repos: RepoRepo;
}

// Constraint names the service translates into domain errors (see schema.ts).
const HANDLE_UNIQUE = 'mocco_projects_workspace_handle_uq';
const APP_BUNDLE_UNIQUE = 'mocco_project_apps_project_platform_bundle_uq';

/** A taken-handle unique violation becomes ProjectHandleTakenError; anything else passes through. */
function mapHandleTaken(error: unknown, handle: string): unknown {
  if (error instanceof UniqueConstraintError && error.constraint === HANDLE_UNIQUE) {
    return new ProjectHandleTakenError(handle, { cause: error });
  }
  return error;
}

/**
 * Owns projects (ADR 0013): "a product the team ships", scoped to a workspace, with
 * its apps and linked repos. Every product line after deploy governance scopes its
 * data to a project. Anemic domain (ADR 0012) — reaches the DB only through repos and
 * maps their DB-layer errors to domain errors. Every operation is workspace-scoped;
 * `requireProject` is the tenant check every project-scoped call goes through.
 */
export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  /** Like requireProject, but also rejects an archived project (it is read-only). */
  private async requireActiveProject(workspaceId: string, projectId: string) {
    const project = await this.requireProject(workspaceId, projectId);
    if (project.archivedAt !== null) {
      throw new ProjectArchivedError(projectId);
    }
    return project;
  }

  /** A project owned by the workspace, or throw ProjectNotFoundError. Product routers
   * call this (through the project procedure) before touching project-scoped data. */
  async requireProject(workspaceId: string, projectId: string) {
    try {
      return await this.deps.projects.getByIdInWorkspace(workspaceId, projectId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new ProjectNotFoundError(projectId, { cause: error });
      }
      throw error;
    }
  }

  /** Create a project. Throws ProjectHandleTakenError when the handle is used in the workspace. */
  async create(workspaceId: string, input: ProjectCreateInput) {
    try {
      return await this.deps.projects.create({ workspaceId, ...input });
    } catch (error) {
      throw mapHandleTaken(error, input.handle);
    }
  }

  /** The workspace's projects, name-ordered. Archived projects only when asked. */
  async list(workspaceId: string, options: { includeArchived: boolean }) {
    return await this.deps.projects.listByWorkspace(workspaceId, options);
  }

  /** Rename a project or change its handle/locale. Throws for a foreign, unknown or archived project. */
  async update(workspaceId: string, projectId: string, values: Partial<ProjectCreateInput>) {
    await this.requireActiveProject(workspaceId, projectId);
    try {
      return await this.deps.projects.update(workspaceId, projectId, values);
    } catch (error) {
      throw mapHandleTaken(error, values.handle ?? '');
    }
  }

  /** Archive (hide, keep data) or unarchive a project. Idempotent. */
  async setArchived(workspaceId: string, projectId: string, isArchived: boolean) {
    const project = await this.requireProject(workspaceId, projectId);
    if ((project.archivedAt !== null) === isArchived) {
      return project;
    }
    return await this.deps.projects.update(workspaceId, projectId, { archivedAt: isArchived ? new Date() : null });
  }

  /** Add an app (build target) to a project. Throws ProjectAppBundleTakenError for a
   * duplicate platform + bundle id in the project. */
  async addApp(workspaceId: string, projectId: string, input: ProjectAppCreateInput) {
    await this.requireActiveProject(workspaceId, projectId);
    try {
      return await this.deps.apps.create({ workspaceId, projectId, ...input });
    } catch (error) {
      if (error instanceof UniqueConstraintError && error.constraint === APP_BUNDLE_UNIQUE) {
        throw new ProjectAppBundleTakenError(input.bundleId ?? '', { cause: error });
      }
      throw error;
    }
  }

  /** An app of the project, or throw ProjectAppNotFoundError (product domains scope per-app data through this). */
  async requireApp(workspaceId: string, projectId: string, appId: string) {
    await this.requireProject(workspaceId, projectId);
    try {
      return await this.deps.apps.getInProject(workspaceId, projectId, appId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new ProjectAppNotFoundError(appId, { cause: error });
      }
      throw error;
    }
  }

  /** A project's apps, name-ordered. */
  async listApps(workspaceId: string, projectId: string) {
    await this.requireProject(workspaceId, projectId);
    return await this.deps.apps.listByProject(workspaceId, projectId);
  }

  /** Remove an app from a project. Throws ProjectAppNotFoundError for an app outside the project. */
  async removeApp(workspaceId: string, projectId: string, appId: string): Promise<void> {
    await this.requireActiveProject(workspaceId, projectId);
    try {
      await this.deps.apps.getInProject(workspaceId, projectId, appId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new ProjectAppNotFoundError(appId, { cause: error });
      }
      throw error;
    }
    await this.deps.apps.delete(workspaceId, projectId, appId);
  }

  /** Link a workspace repo to a project; idempotent. Throws ProjectRepoNotFoundError for
   * a repo the workspace doesn't own (the DB's composite FK would also refuse it). */
  async linkRepo(workspaceId: string, projectId: string, repoId: string) {
    await this.requireActiveProject(workspaceId, projectId);
    try {
      await this.deps.repos.getByIdInWorkspace(workspaceId, repoId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new ProjectRepoNotFoundError(repoId, { cause: error });
      }
      throw error;
    }
    return await this.deps.projectRepos.link({ workspaceId, projectId, repoId });
  }

  /** Unlink a repo from a project; a missing link is a no-op. */
  async unlinkRepo(workspaceId: string, projectId: string, repoId: string): Promise<void> {
    await this.requireActiveProject(workspaceId, projectId);
    await this.deps.projectRepos.unlink(workspaceId, projectId, repoId);
  }

  /** A project's linked repos. */
  async listRepos(workspaceId: string, projectId: string) {
    await this.requireProject(workspaceId, projectId);
    return await this.deps.projectRepos.listByProject(workspaceId, projectId);
  }
}
