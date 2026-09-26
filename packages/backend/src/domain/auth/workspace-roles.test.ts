import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceAdminRequiredError, WorkspaceNotFoundError } from '@backend/domain/auth/errors';
import { createProvider, type Provider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { members } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

describe('WorkspaceService.callerRoles / assertAdmin (pglite)', () => {
  let t: TestDb;
  let provider: Provider;
  let service: WorkspaceService;

  const signUp = async (email: string) => {
    const { headers, response } = await provider.api.signUpEmail({
      body: { email, password: 'fixture-password-1', name: 'fixture-user' },
      returnHeaders: true,
    });
    return { userId: response.user.id, headers: new Headers({ cookie: headers.get('set-cookie') ?? '' }) };
  };

  beforeEach(async () => {
    t = await createTestDb();
    provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    service = new WorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  /** A workspace owned by someone else, with the caller added under `role` (stored as given). */
  const callerWithRole = async (role: string) => {
    const owner = await signUp('owner@example.com');
    const created = await service.create(owner.headers, { name: 'W' });
    const workspaceId = created?.id ?? '';
    const caller = await signUp('caller@example.com');
    await t.db.insert(members).values({ organizationId: workspaceId, userId: caller.userId, role: 'member' });
    // The role check constraint allows comma-joined sets only; write the raw value past it.
    await t.db.execute(`ALTER TABLE mocco_members DROP CONSTRAINT mocco_members_role_check`);
    await t.db
      .update(members)
      .set({ role })
      .where(and(eq(members.organizationId, workspaceId), eq(members.userId, caller.userId)));
    return { workspaceId, headers: caller.headers, owner };
  };

  it.each([
    ['member,admin', ['member', 'admin']],
    [' admin', ['admin']],
    ['owner', ['owner']],
  ])('passes assertAdmin for %j', async (role, roles) => {
    const { workspaceId, headers } = await callerWithRole(role);

    expect(await service.callerRoles(headers, workspaceId)).toEqual(roles);
    await expect(service.assertAdmin(headers, workspaceId)).resolves.toBeUndefined();
  });

  it('refuses a plain member with WorkspaceAdminRequiredError', async () => {
    const { workspaceId, headers } = await callerWithRole('member');

    expect(await service.callerRoles(headers, workspaceId)).toEqual(['member']);
    await expect(service.assertAdmin(headers, workspaceId)).rejects.toBeInstanceOf(WorkspaceAdminRequiredError);
  });

  it('refuses a non-member with WorkspaceNotFoundError', async () => {
    const owner = await signUp('owner@example.com');
    const created = await service.create(owner.headers, { name: 'W' });
    const stranger = await signUp('stranger@example.com');

    await expect(service.callerRoles(stranger.headers, created?.id ?? '')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
    await expect(service.assertAdmin(stranger.headers, created?.id ?? '')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError,
    );
    // The owner of the same workspace passes.
    await expect(service.assertAdmin(owner.headers, created?.id ?? '')).resolves.toBeUndefined();
  });
});
