import { eq } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../db/testing/pglite';

import { createProvider, type Provider } from './provider';

// Full-stack workspace tests on pglite: real migrations + real provider with the
// organization plugin, mapped onto product-termed tables (mocco_workspaces).
describe('workspace (organization plugin) on pglite', () => {
  let t: TestDb;
  let auth: Provider;

  const signUp = async (email: string) => {
    const { headers: resHeaders, response } = await auth.api.signUpEmail({
      body: { email, password: 'fixture-password-1', name: 'fixture-user' },
      returnHeaders: true,
    });
    // Authenticate follow-up API calls with the session cookie the provider set.
    const cookie = resHeaders.get('set-cookie') ?? '';
    return { user: response.user, headers: new Headers({ cookie }) };
  };

  beforeEach(async () => {
    t = await createTestDb();
    auth = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
  });
  afterEach(async () => {
    await t.close();
  });

  it('createWorkspace makes the creator an owner member', async () => {
    const { headers } = await signUp('owner@example.com');

    const org = await auth.api.createOrganization({
      body: { name: 'Acme Lab', slug: 'acme-lab' },
      headers,
    });
    expect(org?.name).toBe('Acme Lab');

    const rows = await t.db.select().from(t.schema.workspaces);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe('acme-lab');

    const memberRows = await t.db.select().from(t.schema.members);
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.role).toBe('owner');
    expect(memberRows[0]?.organizationId).toBe(rows[0]?.id);
  });

  it('creating a workspace sets it as the session-active workspace', async () => {
    const { headers } = await signUp('owner@example.com');
    const org = await auth.api.createOrganization({
      body: { name: 'Acme', slug: 'acme' },
      headers,
    });

    const sessions = await t.db.select().from(t.schema.sessions);
    expect(sessions[0]?.activeOrganizationId).toBe(org?.id);
  });

  it('deleting the active workspace clears the session pointer (FK set null)', async () => {
    const { headers } = await signUp('owner@example.com');
    await auth.api.createOrganization({ body: { name: 'Acme', slug: 'acme' }, headers });

    await t.db.delete(t.schema.workspaces);

    const sessions = await t.db.select().from(t.schema.sessions);
    expect(sessions[0]?.activeOrganizationId).toBeNull(); // onDelete: set null
    expect(await t.db.select().from(t.schema.members)).toHaveLength(0); // cascade
  });

  it('a user can belong to multiple workspaces; setActive switches', async () => {
    const { headers } = await signUp('owner@example.com');
    const first = await auth.api.createOrganization({ body: { name: 'A', slug: 'a-ws' }, headers });
    const second = await auth.api.createOrganization({ body: { name: 'B', slug: 'b-ws' }, headers });

    expect(await t.db.select().from(t.schema.members)).toHaveLength(2);

    await auth.api.setActiveOrganization({ body: { organizationId: first?.id ?? '' }, headers });
    let sessions = await t.db.select().from(t.schema.sessions);
    expect(sessions[0]?.activeOrganizationId).toBe(first?.id);

    await auth.api.setActiveOrganization({ body: { organizationId: second?.id ?? '' }, headers });
    sessions = await t.db.select().from(t.schema.sessions);
    expect(sessions[0]?.activeOrganizationId).toBe(second?.id);
  });

  it('duplicate membership for the same (workspace, user) is rejected by the DB', async () => {
    const { user, headers } = await signUp('owner@example.com');
    await auth.api.createOrganization({ body: { name: 'Acme', slug: 'acme' }, headers });
    const [ws] = await t.db.select().from(t.schema.workspaces);

    await expect(
      t.db.insert(t.schema.members).values({ organizationId: ws?.id ?? '', userId: user.id, role: 'member' }),
    ).rejects.toThrow(); // unique(workspace_id, user_id)

    expect(await t.db.select().from(t.schema.members)).toHaveLength(1); // still just the owner row
  });

  it('rejects an exact duplicate slug', async () => {
    const { headers } = await signUp('owner@example.com');
    await auth.api.createOrganization({ body: { name: 'One', slug: 'same-slug' }, headers });

    await expect(
      auth.api.createOrganization({ body: { name: 'Two', slug: 'same-slug' }, headers }),
    ).rejects.toBeTruthy();
  });

  it('rejects a case-variant slug collision at the DB (lower(slug) unique)', async () => {
    const { headers } = await signUp('owner@example.com');
    await auth.api.createOrganization({ body: { name: 'One', slug: 'acme-lab' }, headers });

    await expect(
      auth.api.createOrganization({ body: { name: 'Two', slug: 'Acme-Lab' }, headers }),
    ).rejects.toBeTruthy();

    expect(await t.db.select().from(t.schema.workspaces)).toHaveLength(1);
  });

  it('rejects roles outside owner/admin/member (DB check)', async () => {
    const { user, headers } = await signUp('owner@example.com');
    await auth.api.createOrganization({ body: { name: 'Acme', slug: 'acme' }, headers });
    const [ws] = await t.db.select().from(t.schema.workspaces);
    const [other] = await t.db.insert(t.schema.users).values({ email: 'other@example.com' }).returning();

    await expect(
      t.db
        .insert(t.schema.members)
        .values({ organizationId: ws?.id ?? '', userId: other?.id ?? '', role: 'superadmin' }),
    ).rejects.toThrow(); // role check constraint

    expect(await t.db.select().from(t.schema.members)).toHaveLength(1); // no row added

    // sanity: the owner row from creation is unaffected
    const owners = await t.db.select().from(t.schema.members).where(eq(t.schema.members.userId, user.id));
    expect(owners).toHaveLength(1);
  });

  it('unauthenticated createWorkspace is rejected', async () => {
    await expect(
      auth.api.createOrganization({ body: { name: 'Nope', slug: 'nope' }, headers: new Headers() }),
    ).rejects.toBeTruthy();
  });

  it('sign-up alone creates no workspace (zero-workspace contract for onboarding UI)', async () => {
    await signUp('fresh@example.com');
    expect(await t.db.select().from(t.schema.workspaces)).toHaveLength(0);
    expect(await t.db.select().from(t.schema.members)).toHaveLength(0);
  });
});
