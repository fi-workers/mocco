// A project's status pages and what they report on: component groups and components (#148).
import { AuditActions } from '@mocco/common/audit';

import { StatusEntityNotFoundError, StatusPageSlugTakenError } from '@backend/domain/status/errors';
import { ComponentGroupRepo } from '@backend/domain/status/repos/component-group.repo';
import { ComponentRepo } from '@backend/domain/status/repos/component.repo';
import { StatusPageRepo } from '@backend/domain/status/repos/page.repo';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { ComponentStatusService } from '@backend/domain/status/ComponentStatusService';
import type { StatusPageRow } from '@backend/domain/status/repos/page.repo';
import type { StatusScope } from '@backend/domain/status/scope';
import type { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import type { Db } from '@backend/infra/db/types';
import type { ComponentGroupInput, ComponentInput, ComponentStatus, StatusPageInput } from '@mocco/common/status';

export interface StatusPageDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  componentStatus: ComponentStatusService;
  /** Marks the public page dirty with each change and requests a publish. */
  snapshots: Pick<SnapshotScheduler, 'change'>;
}

/** Map the slug's unique index to the domain error; rethrow anything else. */
async function slugChecked<T>(slug: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof UniqueConstraintError && error.constraint === 'mocco_status_pages_slug_uq') {
      throw new StatusPageSlugTakenError(slug, { cause: error });
    }
    throw error;
  }
}

export class StatusPageService {
  constructor(private readonly deps: StatusPageDeps) {}

  /** A component's group must be on the component's page. */
  private async assertGroupOnPage(scope: StatusScope, pageId: string, groupId: string | null | undefined) {
    if (groupId === null || groupId === undefined) {
      return;
    }
    const group = await new ComponentGroupRepo(this.deps.db).find(scope, groupId);
    if (group?.pageId !== pageId) {
      throw new StatusEntityNotFoundError('group', groupId);
    }
  }

  async listPages(scope: StatusScope) {
    return await new StatusPageRepo(this.deps.db).list(scope);
  }

  /** The page, or StatusEntityNotFoundError. */
  async requirePage(scope: StatusScope, pageId: string): Promise<StatusPageRow> {
    const page = await new StatusPageRepo(this.deps.db).find(scope, pageId);
    if (page === undefined) {
      throw new StatusEntityNotFoundError('page', pageId);
    }
    return page;
  }

  /** The page with its groups and its components, each with the status it shows. */
  async getPage(scope: StatusScope, pageId: string) {
    const page = await this.requirePage(scope, pageId);
    const [groups, components] = await Promise.all([
      new ComponentGroupRepo(this.deps.db).listForPage(scope, pageId),
      this.deps.componentStatus.forPage(scope, pageId),
    ]);
    return { page, groups, components };
  }

  async createPage(scope: StatusScope, actorUserId: string, input: StatusPageInput) {
    const page = await slugChecked(
      input.slug,
      async () =>
        await this.deps.snapshots.change(async (tx, touch) => {
          const created = await new StatusPageRepo(tx).insert({ ...scope, ...input });
          touch({ workspaceId: scope.workspaceId, pageId: created.id });
          return created;
        }),
    );
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusPageCreated,
      subjectType: 'status_page',
      subjectId: page.id,
      payload: { projectId: scope.projectId, ...input },
    });
    return page;
  }

  async updatePage(scope: StatusScope, pageId: string, input: StatusPageInput) {
    const page = await slugChecked(
      input.slug,
      async () =>
        await this.deps.snapshots.change(async (tx, touch) => {
          const updated = await new StatusPageRepo(tx).update(scope, pageId, input);
          if (updated !== undefined) {
            touch({ workspaceId: scope.workspaceId, pageId });
          }
          return updated;
        }),
    );
    if (page === undefined) {
      throw new StatusEntityNotFoundError('page', pageId);
    }
    return page;
  }

  /** Delete the page with its components, incidents and maintenance windows. */
  async deletePage(scope: StatusScope, actorUserId: string, pageId: string): Promise<void> {
    const page = await this.requirePage(scope, pageId);
    await new StatusPageRepo(this.deps.db).delete(scope, pageId);
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusPageDeleted,
      subjectType: 'status_page',
      subjectId: pageId,
      payload: { projectId: scope.projectId, slug: page.slug, title: page.title },
    });
  }

  async createGroup(scope: StatusScope, pageId: string, input: ComponentGroupInput) {
    await this.requirePage(scope, pageId);
    return await this.deps.snapshots.change(async (tx, touch) => {
      const groups = new ComponentGroupRepo(tx);
      touch({ workspaceId: scope.workspaceId, pageId });
      return await groups.insert({
        ...scope,
        pageId,
        name: input.name,
        position: input.position ?? (await groups.nextPosition(pageId)),
      });
    });
  }

  async updateGroup(scope: StatusScope, groupId: string, input: ComponentGroupInput) {
    const group = await this.deps.snapshots.change(async (tx, touch) => {
      const updated = await new ComponentGroupRepo(tx).update(scope, groupId, input);
      if (updated !== undefined) {
        touch({ workspaceId: scope.workspaceId, pageId: updated.pageId });
      }
      return updated;
    });
    if (group === undefined) {
      throw new StatusEntityNotFoundError('group', groupId);
    }
    return group;
  }

  /** Delete the group; its components stay on the page, ungrouped. */
  async deleteGroup(scope: StatusScope, groupId: string): Promise<void> {
    const group = await new ComponentGroupRepo(this.deps.db).find(scope, groupId);
    if (group === undefined) {
      throw new StatusEntityNotFoundError('group', groupId);
    }
    const isDeleted = await this.deps.snapshots.change(async (tx, touch) => {
      touch({ workspaceId: scope.workspaceId, pageId: group.pageId });
      return await new ComponentGroupRepo(tx).delete(scope, groupId);
    });
    if (!isDeleted) {
      throw new StatusEntityNotFoundError('group', groupId);
    }
  }

  async createComponent(scope: StatusScope, pageId: string, input: ComponentInput) {
    await this.requirePage(scope, pageId);
    await this.assertGroupOnPage(scope, pageId, input.groupId);
    return await this.deps.snapshots.change(async (tx, touch) => {
      const components = new ComponentRepo(tx);
      touch({ workspaceId: scope.workspaceId, pageId });
      return await components.insert({
        ...scope,
        pageId,
        name: input.name,
        description: input.description ?? null,
        groupId: input.groupId ?? null,
        position: input.position ?? (await components.nextPosition(pageId)),
      });
    });
  }

  async updateComponent(scope: StatusScope, componentId: string, input: ComponentInput) {
    const components = new ComponentRepo(this.deps.db);
    const component = await components.find(scope, componentId);
    if (component === undefined) {
      throw new StatusEntityNotFoundError('component', componentId);
    }
    await this.assertGroupOnPage(scope, component.pageId, input.groupId);
    const updated = await this.deps.snapshots.change(async (tx, touch) => {
      touch({ workspaceId: scope.workspaceId, pageId: component.pageId });
      return await new ComponentRepo(tx).update(scope, componentId, {
        name: input.name,
        ...(input.description !== undefined && { description: input.description }),
        ...(input.groupId !== undefined && { groupId: input.groupId }),
        ...(input.position !== undefined && { position: input.position }),
      });
    });
    if (updated === undefined) {
      throw new StatusEntityNotFoundError('component', componentId);
    }
    return updated;
  }

  /** Set the status an operator reports by hand (audited). Open incidents and maintenance
   * still count toward the status the component shows. */
  async setComponentStatus(scope: StatusScope, actorUserId: string, componentId: string, status: ComponentStatus) {
    const before = await new ComponentRepo(this.deps.db).find(scope, componentId);
    const updated =
      before === undefined
        ? undefined
        : await this.deps.snapshots.change(async (tx, touch) => {
            touch({ workspaceId: scope.workspaceId, pageId: before.pageId });
            return await new ComponentRepo(tx).update(scope, componentId, { status });
          });
    if (before === undefined || updated === undefined) {
      throw new StatusEntityNotFoundError('component', componentId);
    }
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.statusComponentStatusChanged,
      subjectType: 'status_component',
      subjectId: componentId,
      payload: { pageId: updated.pageId, from: before.status, to: status },
    });
    return updated;
  }

  async deleteComponent(scope: StatusScope, componentId: string): Promise<void> {
    const component = await new ComponentRepo(this.deps.db).find(scope, componentId);
    if (component === undefined) {
      throw new StatusEntityNotFoundError('component', componentId);
    }
    const isDeleted = await this.deps.snapshots.change(async (tx, touch) => {
      touch({ workspaceId: scope.workspaceId, pageId: component.pageId });
      return await new ComponentRepo(tx).delete(scope, componentId);
    });
    if (!isDeleted) {
      throw new StatusEntityNotFoundError('component', componentId);
    }
  }
}
