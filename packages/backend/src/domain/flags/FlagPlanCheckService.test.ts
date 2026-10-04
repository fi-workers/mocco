import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import { FlagPlanCheckService } from '@backend/domain/flags/FlagPlanCheckService';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';
import { createApprovalService } from '@backend/domain/governance/instance';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { members, projectRepos, providerConnections, repos, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FlagsDomain } from '@backend/domain/flags/compose';
import type { FlagPlanPullRequest } from '@backend/domain/flags/FlagPlanCheckService';
import type { CheckReport } from '@backend/domain/integration/ports';

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

describe('FlagPlanCheckService (pglite)', () => {
  let t: TestDb;
  let domain: FlagsDomain;
  let checks: FlagPlanCheckService;
  let files: Map<string, string>;
  let published: CheckReport[];
  let workspaceId: string;
  let projectId: string;
  let repoId: string;
  let releaser: string;

  const pullRequest = (headSha: string, baseSha = 'base'): FlagPlanPullRequest => ({
    workspaceId,
    repoId,
    ref: { externalAccountId: '1', owner: 'acme', name: 'app' },
    number: 7,
    headSha,
    baseSha,
  });

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    domain = createFlagsDomain(t.db, { audit, approvals: createApprovalService(t.db, audit) });
    files = new Map();
    published = [];
    checks = new FlagPlanCheckService({
      db: t.db,
      files: { getFileAtCommit: async (_ref, sha) => await Promise.resolve(files.get(sha) ?? null) },
      checks: {
        publishCheck: async (_ref, report) => {
          published.push(report);
          await Promise.resolve();
        },
      },
    });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, {
      name: 'Acme Mobile',
      handle: 'app',
    });
    projectId = project.id;
    releaser = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId: releaser });
    const role = await new RoleRepo(t.db).create({ workspaceId, name: 'release' });
    await new RoleMembershipRepo(t.db).add({ workspaceId, roleId: role.id, userId: releaser });
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
    await domain.flags.createEnvironment(workspaceId, projectId, releaser, { key: 'staging', name: 'Staging' });
    const production = await domain.flags.createEnvironment(workspaceId, projectId, releaser, {
      key: 'production',
      name: 'Production',
    });
    await domain.flagGovernance.setChangeGate(workspaceId, projectId, releaser, {
      environmentId: production.id,
      gate: { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false },
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('reports what merging would do in each environment, and changes nothing', async () => {
    files.set('h1', FILE('on'));

    await checks.checkPullRequest(pullRequest('h1'));

    const report = expectOne(published);
    expect(report).toMatchObject({ name: 'Mocco flags plan', headSha: 'h1', conclusion: 'success' });
    expect(report.summary).toContain(
      '| Acme Mobile | 1 new flag · 4 changes in 2 environments · Production waits for approval |',
    );
    expect(report.text).toContain('- Creates `checkout` (boolean');
    expect(report.text).toContain(
      '| Production (`production`) | 2 | Waits for approval (1 × `release`, not by its proposers) |',
    );
    expect(report.text).toContain('| Staging (`staging`) | 2 | At once |');
    expect(report.text).toContain('- `checkout`: serve `on` by default; turn on');
    expect(await new FlagRepo(t.db).listByProject(workspaceId, projectId)).toEqual([]);
  });

  it('plans against the project as it is now, not against the base file', async () => {
    files.set('base', FILE('off'));
    files.set('h1', FILE('on'));
    await domain.flags.createFlag(workspaceId, projectId, releaser, {
      key: 'checkout',
      type: 'boolean',
      variants: { on: true, off: false },
      defaultVariant: 'off',
      offVariant: 'off',
      description: null,
      lifecycle: 'temporary',
    });

    await checks.checkPullRequest(pullRequest('h1'));

    const report = expectOne(published);
    expect(report.text).toContain('- Takes over `checkout` from the console');
    expect(report.text).toContain('- Updates `checkout`: description');
  });

  it('reports a refused file as neutral with its issues', async () => {
    files.set('h1', FILE('on').replace('staging:', 'qa:'));

    await checks.checkPullRequest(pullRequest('h1'));

    const report = expectOne(published);
    expect(report.conclusion).toBe('neutral');
    expect(report.text).toContain('| `flags.checkout.targets.qa` | There is no environment "qa" in this project |');
  });

  it('reports a file that does not parse, with its line', async () => {
    files.set('h1', 'version: 1\nflags:\n  checkout: [\n');

    await checks.checkPullRequest(pullRequest('h1'));

    expect(expectOne(published)).toMatchObject({
      conclusion: 'neutral',
      title: '.mocco/flags.yml is refused: 1 issue',
    });
  });

  it('reports nothing without the file, or when the PR leaves it as it is on the base', async () => {
    files.set('base', FILE('on'));
    files.set('same', FILE('on'));

    await checks.checkPullRequest(pullRequest('missing'));
    await checks.checkPullRequest(pullRequest('same'));

    expect(published).toEqual([]);
  });

  it('reports nothing for a repo linked to no project', async () => {
    files.set('h1', FILE('on'));
    await t.db.delete(projectRepos);

    await checks.checkPullRequest(pullRequest('h1'));

    expect(published).toEqual([]);
  });
});
