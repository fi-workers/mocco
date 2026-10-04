import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ComponentStatuses } from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { StatusEntityNotFoundError, StatusPageSlugTakenError } from '@backend/domain/status/errors';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, statusComponents, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';

describe('StatusPageService (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let scope: StatusScope;
  let actor: string;

  /** A page with two components. */
  const setUp = async () => {
    const page = await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    const api = await status.statusPages.createComponent(scope, page.id, { name: 'API' });
    const web = await status.statusPages.createComponent(scope, page.id, { name: 'Dashboard' });
    return { page, api, web };
  };

  beforeEach(async () => {
    t = await createTestDb();
    status = createStatusDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }) });
    const workspace = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning());
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspace.id, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId: workspace.id, projectId: project.id };
  });
  afterEach(async () => {
    await t.close();
  });

  it('keeps page slugs unique across projects', async () => {
    await setUp();
    const other = await createProjectDomain(t.db).projects.create(scope.workspaceId, { name: 'B', handle: 'b' });
    const otherScope = { ...scope, projectId: other.id };
    const second = await status.statusPages.createPage(otherScope, actor, { slug: 'other', title: 'Other' });

    await expect(
      status.statusPages.createPage(otherScope, actor, { slug: 'acme', title: 'Other' }),
    ).rejects.toBeInstanceOf(StatusPageSlugTakenError);
    await expect(
      status.statusPages.updatePage(otherScope, second.id, { slug: 'acme', title: 'Other' }),
    ).rejects.toBeInstanceOf(StatusPageSlugTakenError);
    const pages = await status.statusPages.listPages(scope);
    expect(pages.map(page => page.slug)).toEqual(['acme']);
  });

  it('orders components, groups them, and ungroups them when the group is deleted', async () => {
    const { page, api } = await setUp();
    const group = await status.statusPages.createGroup(scope, page.id, { name: 'Core' });
    await status.statusPages.updateComponent(scope, api.id, { name: 'Public API', groupId: group.id });

    const detail = await status.statusPages.getPage(scope, page.id);
    expect(detail.groups.map(row => [row.name, row.position])).toEqual([['Core', 0]]);
    expect(detail.components.map(row => [row.name, row.position, row.groupId])).toEqual([
      ['Public API', 0, group.id],
      ['Dashboard', 1, null],
    ]);
    await status.statusPages.deleteGroup(scope, group.id);
    const after = await status.statusPages.getPage(scope, page.id);
    expect(after.groups).toEqual([]);
    expect(after.components.map(row => row.groupId)).toEqual([null, null]);
  });

  it('rejects a group from another page, in the service and in the database', async () => {
    const { api } = await setUp();
    const second = await status.statusPages.createPage(scope, actor, { slug: 'second', title: 'Second' });
    const foreignGroup = await status.statusPages.createGroup(scope, second.id, { name: 'Elsewhere' });

    await expect(
      status.statusPages.updateComponent(scope, api.id, { name: 'API', groupId: foreignGroup.id }),
    ).rejects.toBeInstanceOf(StatusEntityNotFoundError);
    await expect(
      t.db.update(statusComponents).set({ groupId: foreignGroup.id }).where(eq(statusComponents.id, api.id)),
    ).rejects.toThrow();
  });

  it('deletes a page with everything on it', async () => {
    const { page } = await setUp();
    await status.statusPages.createGroup(scope, page.id, { name: 'Core' });

    await status.statusPages.deletePage(scope, actor, page.id);

    await expect(status.statusPages.getPage(scope, page.id)).rejects.toBeInstanceOf(StatusEntityNotFoundError);
    expect(await t.db.select().from(statusComponents)).toEqual([]);
  });

  it('audits page creation and deletion and manual component status changes', async () => {
    const { page, web } = await setUp();
    await status.statusPages.setComponentStatus(scope, actor, web.id, ComponentStatuses.partialOutage);
    await status.statusPages.deletePage(scope, actor, page.id);

    const rows = await t.db.select().from(auditLog).orderBy(auditLog.seq);
    expect(rows.map(row => [row.action, row.subjectType, row.actorUserId])).toEqual([
      [AuditActions.statusPageCreated, 'status_page', actor],
      [AuditActions.statusComponentStatusChanged, 'status_component', actor],
      [AuditActions.statusPageDeleted, 'status_page', actor],
    ]);
    expect(rows[1]?.payload).toEqual({ pageId: page.id, from: 'operational', to: 'partial_outage' });
  });
});
