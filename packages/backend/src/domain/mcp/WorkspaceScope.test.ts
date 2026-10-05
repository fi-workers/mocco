// Workspace resolution is the only thing standing between a tool call and another
// tenant's data, so these tests are mostly about what it refuses.
import { describe, expect, it } from 'vitest';

import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';

const memberships = (rows: { workspaceId: string; name: string; role: string }[]) => ({
  listForUser: async (userId: string) => await Promise.resolve(userId === 'ada' ? rows : []),
  isMember: async (userId: string, workspaceId: string) =>
    await Promise.resolve(userId === 'ada' && rows.some(row => row.workspaceId === workspaceId)),
});

/** The refusal text, so two refusals can be compared for what they give away. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const ONE = [{ workspaceId: 'w1', name: 'Acme', role: 'owner' }];
const TWO = [...ONE, { workspaceId: 'w2', name: 'Beta', role: 'member' }];

describe('WorkspaceScope', () => {
  it('needs nothing said when the caller is in exactly one workspace', async () => {
    const scope = new WorkspaceScope({ memberships: memberships(ONE) });

    expect(await scope.resolve('ada')).toBe('w1');
  });

  it('names the choices when the caller is in several, rather than guessing', async () => {
    const scope = new WorkspaceScope({ memberships: memberships(TWO) });

    await expect(scope.resolve('ada')).rejects.toThrow(/Acme \(w1\).*Beta \(w2\)/u);
  });

  it('says so plainly when the caller is in none', async () => {
    const scope = new WorkspaceScope({ memberships: memberships(ONE) });

    await expect(scope.resolve('stranger')).rejects.toThrow(/not a member of any workspace/u);
  });

  it('accepts a workspace the caller is in', async () => {
    const scope = new WorkspaceScope({ memberships: memberships(TWO) });

    expect(await scope.resolve('ada', 'w2')).toBe('w2');
  });

  it('refuses a workspace the caller is not in — an id in a tool call grants nothing', async () => {
    const scope = new WorkspaceScope({ memberships: memberships(TWO) });

    await expect(scope.resolve('ada', 'someone-elses')).rejects.toThrow(/No workspace someone-elses/u);
  });

  it('refuses even a real workspace when the caller is not a member of it', async () => {
    // `stranger` is in nothing, so w1 exists but is not theirs.
    const scope = new WorkspaceScope({ memberships: memberships(ONE) });

    await expect(scope.resolve('stranger', 'w1')).rejects.toThrow(/No workspace w1/u);
  });

  it('tells a non-member nothing about whether the workspace exists', async () => {
    const scope = new WorkspaceScope({ memberships: memberships(ONE) });

    const real = await messageOf(scope.resolve('stranger', 'w1'));
    const invented = await messageOf(scope.resolve('stranger', 'w9'));

    // Same shape either way: existence is not leaked through the difference.
    expect(real.replace('w1', 'X')).toBe(invented.replace('w9', 'X'));
  });

  describe('requireAdmin', () => {
    const ROLES = [
      { workspaceId: 'w1', name: 'Acme', role: 'owner' },
      { workspaceId: 'w2', name: 'Beta', role: 'member' },
      { workspaceId: 'w3', name: 'Gamma', role: 'member, admin' },
    ];

    it('lets an owner, or an admin whose roles are stored comma-joined, through', async () => {
      const scope = new WorkspaceScope({ memberships: memberships(ROLES) });

      await expect(scope.requireAdmin('ada', 'w1')).resolves.toBeUndefined();
      await expect(scope.requireAdmin('ada', 'w3')).resolves.toBeUndefined();
    });

    it('refuses a plain member, as the console does', async () => {
      const scope = new WorkspaceScope({ memberships: memberships(ROLES) });

      await expect(scope.requireAdmin('ada', 'w2')).rejects.toThrow(/Only an owner or admin of workspace w2/u);
    });

    it('refuses a non-member exactly like a workspace that does not exist', async () => {
      const scope = new WorkspaceScope({ memberships: memberships(ROLES) });

      const real = await messageOf(scope.requireAdmin('stranger', 'w1'));
      const invented = await messageOf(scope.requireAdmin('stranger', 'w9'));

      expect(real).toContain('No workspace w1');
      expect(real.replace('w1', 'X')).toBe(invented.replace('w9', 'X'));
    });
  });
});
