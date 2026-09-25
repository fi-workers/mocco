import { randomUUID } from 'node:crypto';

import { AppPlatforms } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProjectAppBundleTakenError,
  ProjectAppNotFoundError,
  ProjectArchivedError,
  ProjectHandleTakenError,
  ProjectNotFoundError,
  ProjectRepoNotFoundError,
} from '@backend/domain/project/errors';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { projectRepos, projects, providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { ProjectService } from '@backend/domain/project/ProjectService';

describe('ProjectService (pglite)', () => {
  let t: TestDb;
  let service: ProjectService;

  beforeEach(async () => {
    t = await createTestDb();
    service = createProjectDomain(t.db).projects;
  });
  afterEach(async () => {
    await t.close();
  });

  async function seedWorkspace(name = 'W'): Promise<string> {
    return expectOne(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  async function seedRepo(workspaceId: string): Promise<string> {
    const connectionId = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    ).id;
    return expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId,
          externalRepoId: randomUUID(),
          owner: 'acme',
          name: 'app',
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
  }

  describe('projects', () => {
    it('creates and lists projects name-ordered, scoped to the workspace', async () => {
      const workspaceId = await seedWorkspace();
      await service.create(workspaceId, { name: 'Web', handle: 'web' });
      await service.create(workspaceId, { name: 'Mobile', handle: 'mobile' });
      await service.create(await seedWorkspace('other'), { name: 'Admin', handle: 'admin' });

      const listed = await service.list(workspaceId, { includeArchived: false });
      expect(listed.map(project => project.name)).toEqual(['Mobile', 'Web']);
      expect(listed[0]?.defaultLocale).toBe('en');
    });

    it('rejects a handle already used in the workspace, but allows it in another workspace', async () => {
      const workspaceId = await seedWorkspace();
      await service.create(workspaceId, { name: 'Web', handle: 'web' });

      await expect(service.create(workspaceId, { name: 'Web 2', handle: 'web' })).rejects.toBeInstanceOf(
        ProjectHandleTakenError,
      );
      await expect(service.create(await seedWorkspace('other'), { name: 'Web', handle: 'web' })).resolves.toMatchObject(
        {
          handle: 'web',
        },
      );
    });

    it('enforces the handle format at the DB, not only at the API boundary', async () => {
      const workspaceId = await seedWorkspace();
      await expect(t.db.insert(projects).values({ workspaceId, name: 'Bad', handle: 'Bad Handle!' })).rejects.toThrow();
      await expect(t.db.insert(projects).values({ workspaceId, name: 'Bad', handle: '-leading' })).rejects.toThrow();
    });

    it('renames a project and maps a taken handle on update', async () => {
      const workspaceId = await seedWorkspace();
      const web = await service.create(workspaceId, { name: 'Web', handle: 'web' });
      await service.create(workspaceId, { name: 'Mobile', handle: 'mobile' });

      expect(await service.update(workspaceId, web.id, { name: 'Website' })).toMatchObject({ name: 'Website' });
      await expect(service.update(workspaceId, web.id, { handle: 'mobile' })).rejects.toBeInstanceOf(
        ProjectHandleTakenError,
      );
    });

    it('archives and unarchives idempotently; archived projects are hidden and read-only', async () => {
      const workspaceId = await seedWorkspace();
      const web = await service.create(workspaceId, { name: 'Web', handle: 'web' });

      const archived = await service.setArchived(workspaceId, web.id, true);
      expect(archived.archivedAt).not.toBeNull();
      const again = await service.setArchived(workspaceId, web.id, true);
      expect(again.archivedAt).toEqual(archived.archivedAt);
      expect(await service.list(workspaceId, { includeArchived: false })).toHaveLength(0);
      expect(await service.list(workspaceId, { includeArchived: true })).toHaveLength(1);
      await expect(service.update(workspaceId, web.id, { name: 'x' })).rejects.toBeInstanceOf(ProjectArchivedError);
      await expect(
        service.addApp(workspaceId, web.id, { platform: AppPlatforms.web, name: 'Site' }),
      ).rejects.toBeInstanceOf(ProjectArchivedError);

      const unarchived = await service.setArchived(workspaceId, web.id, false);
      expect(unarchived.archivedAt).toBeNull();
    });

    it('never resolves a project through another workspace (tenant isolation)', async () => {
      const workspaceId = await seedWorkspace();
      const web = await service.create(workspaceId, { name: 'Web', handle: 'web' });
      const otherId = await seedWorkspace('other');

      await expect(service.requireProject(otherId, web.id)).rejects.toBeInstanceOf(ProjectNotFoundError);
      await expect(service.update(otherId, web.id, { name: 'x' })).rejects.toBeInstanceOf(ProjectNotFoundError);
      await expect(service.listApps(otherId, web.id)).rejects.toBeInstanceOf(ProjectNotFoundError);
      await expect(service.requireProject(workspaceId, randomUUID())).rejects.toBeInstanceOf(ProjectNotFoundError);
    });
  });

  describe('apps', () => {
    it('adds, lists and removes apps per platform', async () => {
      const workspaceId = await seedWorkspace();
      const project = await service.create(workspaceId, { name: 'Acme', handle: 'acme' });

      const ios = await service.addApp(workspaceId, project.id, {
        platform: AppPlatforms.ios,
        name: 'Mobile',
        bundleId: 'com.acme.app',
        storeAppId: '123456789',
      });
      await service.addApp(workspaceId, project.id, {
        platform: AppPlatforms.web,
        name: 'Web',
        webOrigins: ['https://acme.example'],
      });

      const apps = await service.listApps(workspaceId, project.id);
      expect(apps.map(app => app.name)).toEqual(['Mobile', 'Web']);
      expect(apps[1]?.webOrigins).toEqual(['https://acme.example']);

      await service.removeApp(workspaceId, project.id, ios.id);
      expect(await service.listApps(workspaceId, project.id)).toHaveLength(1);
    });

    it('rejects a duplicate platform + bundle id in the same project only', async () => {
      const workspaceId = await seedWorkspace();
      const acme = await service.create(workspaceId, { name: 'Acme', handle: 'acme' });
      const other = await service.create(workspaceId, { name: 'Other', handle: 'other' });
      const app = { platform: AppPlatforms.android, name: 'Android', bundleId: 'com.acme.app' };

      await service.addApp(workspaceId, acme.id, app);
      await expect(service.addApp(workspaceId, acme.id, app)).rejects.toBeInstanceOf(ProjectAppBundleTakenError);
      // Same bundle id on another platform, or in another project, is fine.
      await service.addApp(workspaceId, acme.id, { ...app, platform: AppPlatforms.ios });
      await service.addApp(workspaceId, other.id, app);
    });

    it('does not remove an app through another project', async () => {
      const workspaceId = await seedWorkspace();
      const acme = await service.create(workspaceId, { name: 'Acme', handle: 'acme' });
      const other = await service.create(workspaceId, { name: 'Other', handle: 'other' });
      const app = await service.addApp(workspaceId, acme.id, { platform: AppPlatforms.web, name: 'Site' });

      await expect(service.removeApp(workspaceId, other.id, app.id)).rejects.toBeInstanceOf(ProjectAppNotFoundError);
      expect(await service.listApps(workspaceId, acme.id)).toHaveLength(1);
    });
  });

  describe('repo links', () => {
    it('links a workspace repo idempotently, lists and unlinks it', async () => {
      const workspaceId = await seedWorkspace();
      const project = await service.create(workspaceId, { name: 'Acme', handle: 'acme' });
      const repoId = await seedRepo(workspaceId);

      const link = await service.linkRepo(workspaceId, project.id, repoId);
      expect(await service.linkRepo(workspaceId, project.id, repoId)).toEqual(link);
      expect(await service.listRepos(workspaceId, project.id)).toHaveLength(1);

      await service.unlinkRepo(workspaceId, project.id, repoId);
      expect(await service.listRepos(workspaceId, project.id)).toHaveLength(0);
    });

    it("refuses to link another workspace's repo", async () => {
      const workspaceId = await seedWorkspace();
      const project = await service.create(workspaceId, { name: 'Acme', handle: 'acme' });
      const foreignRepoId = await seedRepo(await seedWorkspace('other'));

      await expect(service.linkRepo(workspaceId, project.id, foreignRepoId)).rejects.toBeInstanceOf(
        ProjectRepoNotFoundError,
      );
    });

    it('the composite FKs refuse a cross-workspace link even on a direct insert', async () => {
      const workspaceId = await seedWorkspace();
      const project = await service.create(workspaceId, { name: 'Acme', handle: 'acme' });
      const foreignRepoId = await seedRepo(await seedWorkspace('other'));

      await expect(
        t.db.insert(projectRepos).values({ workspaceId, projectId: project.id, repoId: foreignRepoId }),
      ).rejects.toThrow();
    });
  });
});
