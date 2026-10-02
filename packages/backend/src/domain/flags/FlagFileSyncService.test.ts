import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import { RepoManagedFlagError } from '@backend/domain/flags/errors';
import { FlagFileSyncService } from '@backend/domain/flags/FlagFileSyncService';
import { FlagChangesetRepo } from '@backend/domain/flags/repos/flag-changeset.repo';
import { FlagConfigRepo } from '@backend/domain/flags/repos/flag-config.repo';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';
import { SelfApprovalError } from '@backend/domain/governance/errors';
import { createApprovalService } from '@backend/domain/governance/instance';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import {
  accounts,
  members,
  projectRepos,
  providerConnections,
  repos,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FlagsDomain } from '@backend/domain/flags/compose';
import type { FlagFilePush } from '@backend/domain/flags/FlagFileSyncService';

const FILE = (production: string) => `
version: 1
flags:
  checkout:
    description: New checkout
    targets:
      staging:
        default: on
      production:
        default: ${production}
`;

describe('FlagFileSyncService (pglite)', () => {
  let t: TestDb;
  let domain: FlagsDomain;
  let sync: FlagFileSyncService;
  let files: Map<string, string>;
  let workspaceId: string;
  let projectId: string;
  let repoId: string;
  let developer: string;
  let releaser: string;
  let staging: string;
  let production: string;

  const push = (commitSha: string): FlagFilePush => ({
    workspaceId,
    repoId,
    ref: { externalAccountId: '1', owner: 'acme', name: 'app' },
    commitSha,
    senderGithubId: '4242',
    authorEmail: null,
  });
  const configOf = async (environmentId: string) => {
    const rows = await new FlagConfigRepo(t.db).listForEnvironment(workspaceId, environmentId);
    return rows.find(row => row.flag.key === 'checkout')?.config;
  };
  const syncStates = async () => {
    const rows = await domain.flags.fileSyncs(workspaceId, projectId);
    return rows.map(row => row.state);
  };
  const versionOf = async (environmentId: string) => {
    const environments = await domain.flags.listEnvironments(workspaceId, projectId);
    return environments.find(environment => environment.id === environmentId)?.currentVersion ?? 0;
  };
  const pendingOf = async (environmentId: string) =>
    await new FlagChangesetRepo(t.db).findPendingFromRepo(workspaceId, environmentId, repoId);

  const seedMember = async (...roleNames: string[]) => {
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId });
    await roleNames.reduce(async (previous, name) => {
      await previous;
      const roles = new RoleRepo(t.db);
      const existing = await roles.listByWorkspace(workspaceId);
      const role = existing.find(candidate => candidate.name === name) ?? (await roles.create({ workspaceId, name }));
      await new RoleMembershipRepo(t.db).add({ workspaceId, roleId: role.id, userId });
    }, Promise.resolve());
    return userId;
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    domain = createFlagsDomain(t.db, { audit, approvals: createApprovalService(t.db, audit) });
    files = new Map();
    sync = new FlagFileSyncService({
      db: t.db,
      audit,
      flags: domain.flags,
      governance: domain.flagGovernance,
      files: { getFileAtCommit: async (_ref, sha) => await Promise.resolve(files.get(sha) ?? null) },
    });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'App', handle: 'app' });
    projectId = project.id;
    developer = await seedMember('release');
    await t.db.insert(accounts).values({ accountId: '4242', providerId: 'github', userId: developer });
    releaser = await seedMember('release');
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: '1', accountLogin: 'acme' })
        .returning(),
    );
    repoId = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: connection.id,
          externalRepoId: '9',
          owner: 'acme',
          name: 'app',
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
    await t.db.insert(projectRepos).values({ workspaceId, projectId, repoId });
    const stagingEnvironment = await domain.flags.createEnvironment(workspaceId, projectId, releaser, {
      key: 'staging',
      name: 'Staging',
    });
    const productionEnvironment = await domain.flags.createEnvironment(workspaceId, projectId, releaser, {
      key: 'production',
      name: 'Production',
    });
    staging = stagingEnvironment.id;
    production = productionEnvironment.id;
    await domain.flagGovernance.setChangeGate(workspaceId, projectId, releaser, {
      environmentId: production,
      gate: { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false },
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('applies to unprotected environments, holds protected ones for a gate the pusher cannot satisfy', async () => {
    files.set('a1', FILE('on'));

    await sync.syncPush(push('a1'));

    const flag = expectOne(await new FlagRepo(t.db).listByProject(workspaceId, projectId));
    const pending = await pendingOf(production);
    expect(flag).toMatchObject({ key: 'checkout', managedBy: 'repo', description: 'New checkout' });
    expect(await configOf(staging)).toMatchObject({ enabled: true, defaultVariant: 'on' });
    expect(await configOf(production)).toMatchObject({ enabled: false });
    expect(pending).toMatchObject({ source: 'repo', commitSha: 'a1', proposedByUserId: developer });
    expect(await syncStates()).toEqual(['pending_approval']);

    const changeset = pending as NonNullable<typeof pending>;
    const voteBy = async (userId: string) =>
      await domain.flagGovernance.vote(workspaceId, projectId, userId, {
        changesetId: changeset.id,
        contentHash: changeset.contentHash,
        decision: 'approve',
      });
    await expect(voteBy(developer)).rejects.toBeInstanceOf(SelfApprovalError);
    await voteBy(releaser);
    expect(await configOf(production)).toMatchObject({ enabled: true, defaultVariant: 'on' });
  });

  it('bars the commit author too when someone else merged, and keeps them through a rebase', async () => {
    const author = await seedMember('release');
    await t.db.update(users).set({ email: 'author@acme.test', emailVerified: true }).where(eq(users.id, author));
    const third = await seedMember('release');
    files.set('g1', FILE('on'));

    await sync.syncPush({ ...push('g1'), authorEmail: 'Author@acme.test' });

    const pending = (await pendingOf(production)) as NonNullable<Awaited<ReturnType<typeof pendingOf>>>;
    expect(pending).toMatchObject({ proposedByUserId: developer, coProposerUserIds: [author] });
    // Another change moves production on, so the developer rebases the repo changeset.
    await domain.flagKillSwitch.kill(workspaceId, projectId, releaser, {
      environmentId: production,
      flagKey: 'checkout',
      reason: 'incident',
    });
    const { changeset: rebased } = await domain.flagGovernance.rebase(workspaceId, projectId, developer, pending.id);
    expect(rebased).toMatchObject({ source: 'repo', commitSha: 'g1', coProposerUserIds: [author] });
    expect(await pendingOf(production)).toMatchObject({ id: rebased.id });

    const voteBy = async (userId: string) =>
      await domain.flagGovernance.vote(workspaceId, projectId, userId, {
        changesetId: rebased.id,
        contentHash: rebased.contentHash,
        decision: 'approve',
      });
    await expect(voteBy(developer)).rejects.toBeInstanceOf(SelfApprovalError);
    await expect(voteBy(author)).rejects.toBeInstanceOf(SelfApprovalError);
    await voteBy(third);
    expect(await configOf(production)).toMatchObject({ enabled: true, defaultVariant: 'on' });
  });

  it('refuses an invalid file whole: a visible sync error and no flag, no changeset', async () => {
    files.set('b1', FILE('maybe'));

    await sync.syncPush(push('b1'));

    const [row] = await domain.flags.fileSyncs(workspaceId, projectId);
    expect(row).toMatchObject({ state: 'invalid', commitSha: 'b1' });
    expect(row?.issues.map(issue => issue.path)).toEqual(['flags.checkout.targets.production.default']);
    expect(await new FlagRepo(t.db).listByProject(workspaceId, projectId)).toEqual([]);
    expect(await pendingOf(production)).toBeUndefined();
  });

  it('lets a newer push replace the pending one, and a push that matches clear it', async () => {
    files.set('c1', FILE('on'));
    files.set('c2', FILE('off'));
    files.set(
      'c3',
      `version: 1\nflags:\n  checkout:\n    description: New checkout\n    targets:\n      staging: { default: on }\n`,
    );

    await sync.syncPush(push('c1'));
    const first = await pendingOf(production);
    await sync.syncPush(push('c2'));
    const second = await pendingOf(production);
    await sync.syncPush(push('c3'));

    expect(first?.commitSha).toBe('c1');
    expect(second?.commitSha).toBe('c2');
    const replaced = await new FlagChangesetRepo(t.db).find(workspaceId, first?.id ?? '');
    expect(replaced?.state).toBe('superseded');
    expect(await pendingOf(production)).toBeUndefined();
    expect(await syncStates()).toEqual(['unchanged', 'pending_approval', 'pending_approval']);
  });

  it('never un-kills a flag', async () => {
    files.set('d1', FILE('on'));
    files.set('d2', FILE('on').replace('staging:\n        default: on', 'staging:\n        default: off'));
    await sync.syncPush(push('d1'));
    await domain.flagKillSwitch.kill(workspaceId, projectId, releaser, {
      environmentId: staging,
      flagKey: 'checkout',
      reason: 'incident',
    });

    await sync.syncPush(push('d2'));

    expect(await configOf(staging)).toMatchObject({ killed: true, defaultVariant: 'off' });
  });

  it('makes repo-managed flags read-only in the console, except the kill switch', async () => {
    files.set('f1', FILE('on'));
    await sync.syncPush(push('f1'));
    const currentVersion = await versionOf(staging);
    const edit = async () =>
      await domain.flags.applyChangeset(workspaceId, projectId, releaser, {
        environmentId: staging,
        baseVersion: currentVersion,
        ops: [{ op: 'set_enabled', flagKey: 'checkout', enabled: false }],
        reason: null,
      });

    await expect(edit()).rejects.toBeInstanceOf(RepoManagedFlagError);
    await expect(
      domain.flags.setClientVisible(workspaceId, projectId, releaser, { flagKey: 'checkout', clientVisible: true }),
    ).rejects.toBeInstanceOf(RepoManagedFlagError);
    await domain.flagKillSwitch.kill(workspaceId, projectId, releaser, {
      environmentId: staging,
      flagKey: 'checkout',
      reason: 'incident',
    });
    await domain.flags.applyChangeset(workspaceId, projectId, releaser, {
      environmentId: staging,
      baseVersion: await versionOf(staging),
      ops: [{ op: 'restore', flagKey: 'checkout' }],
      reason: null,
    });
    expect(await configOf(staging)).toMatchObject({ killed: false });
  });

  it('leaves a repo without the file, or not linked to the project, alone', async () => {
    await sync.syncPush(push('none'));
    files.set('e1', FILE('on'));
    await sync.syncPush({ ...push('e1'), repoId: randomUUID() });

    expect(await domain.flags.fileSyncs(workspaceId, projectId)).toEqual([]);
  });
});
