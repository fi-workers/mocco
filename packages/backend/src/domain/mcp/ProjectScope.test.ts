// Project resolution sits between a tool call and a project's data, so these tests are
// mostly about the order it refuses in: nothing about a project is looked up for a
// caller who is not a member of the workspace.
import { Products } from '@mocco/common/project';
import { describe, expect, it } from 'vitest';

import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { ProductNotEnabledError, ProjectNotFoundError } from '@backend/domain/project/errors';

const ONE = [{ workspaceId: 'w1', name: 'Acme', role: 'owner' }];

const workspaces = new WorkspaceScope({
  memberships: {
    listForUser: async (userId: string) => await Promise.resolve(userId === 'ada' ? ONE : []),
    isMember: async (userId: string, workspaceId: string) =>
      await Promise.resolve(userId === 'ada' && workspaceId === 'w1'),
  },
});

function scopeOver(projects: { id: string; name: string }[], options: { flagsOn?: boolean } = {}) {
  const looked: string[] = [];
  const scope = new ProjectScope({
    workspaces,
    projects: {
      list: async workspaceId => {
        looked.push(`list ${workspaceId}`);
        // Only id and name are read; the rest of a project row is beside the point here.
        return await Promise.resolve(projects as never);
      },
      requireProject: async (workspaceId, projectId) => {
        looked.push(`require ${workspaceId}/${projectId}`);
        const found = projects.find(each => each.id === projectId);
        if (found === undefined) {
          throw new ProjectNotFoundError(projectId);
        }
        return await Promise.resolve(found as never);
      },
    },
    products: {
      assertEnabled: async (_workspaceId, product) => {
        if (options.flagsOn === false) {
          throw new ProductNotEnabledError(product);
        }
        await Promise.resolve();
      },
    },
  });
  return { scope, looked };
}

describe('ProjectScope', () => {
  it('needs nothing said when the workspace has exactly one project', async () => {
    const { scope } = scopeOver([{ id: 'p1', name: 'Shop' }]);

    expect(await scope.resolve('ada', {}, Products.flags)).toEqual({ workspaceId: 'w1', projectId: 'p1' });
  });

  it('names the choices when there are several, rather than guessing', async () => {
    const { scope } = scopeOver([
      { id: 'p1', name: 'Shop' },
      { id: 'p2', name: 'Admin' },
    ]);

    await expect(scope.resolve('ada', {}, Products.flags)).rejects.toThrow(/Shop \(p1\).*Admin \(p2\)/u);
  });

  it('refuses a non-member before looking up any project', async () => {
    const { scope, looked } = scopeOver([{ id: 'p1', name: 'Shop' }]);

    await expect(scope.resolve('bob', { workspaceId: 'w1', projectId: 'p1' }, Products.flags)).rejects.toThrow(
      /No workspace w1/u,
    );
    expect(looked).toEqual([]);
  });

  it('looks a named project up inside the resolved workspace only', async () => {
    const { scope, looked } = scopeOver([{ id: 'p1', name: 'Shop' }]);

    await expect(scope.resolve('ada', { projectId: 'p9' }, Products.flags)).rejects.toThrow(ProjectNotFoundError);
    expect(looked).toEqual(['require w1/p9']);
  });

  it('refuses where the product is off', async () => {
    const { scope, looked } = scopeOver([{ id: 'p1', name: 'Shop' }], { flagsOn: false });

    await expect(scope.resolve('ada', { projectId: 'p1' }, Products.flags)).rejects.toThrow(ProductNotEnabledError);
    expect(looked).toEqual([]);
  });
});
