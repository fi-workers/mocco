import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import { InvalidChangeError } from '@backend/domain/flags/errors';
import { createApprovalService } from '@backend/domain/governance/instance';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import {
  commitConfigs,
  commits,
  projectRepos,
  providerConnections,
  repos,
  runs,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { FlagsDomain } from '@backend/domain/flags/compose';

/** A one-file ustar archive, gzipped like GitHub's. */
async function archiveOf(path: string, content: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode(`acme-app-sha/${path}`), 0);
  header.set(new TextEncoder().encode(`${data.length.toString(8).padStart(11, '0')}\0`), 124);
  header[156] = 0x30;
  const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
  body.set(data);
  return await promisify(gzip)(new Uint8Array([...header, ...body, ...new Uint8Array(1024)]));
}

describe('flag environment timeline (pglite)', () => {
  let t: TestDb;
  let domain: FlagsDomain;
  let archiveFetches: string[];
  let workspaceId: string;
  let projectId: string;
  let userId: string;
  let environmentId: string;

  const seedRepo = async (isLinked: boolean) => {
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    const repo = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: connection.id,
          externalRepoId: randomUUID(),
          owner: 'acme',
          name: 'app',
          defaultBranch: 'main',
        })
        .returning(),
    );
    if (isLinked) {
      await t.db.insert(projectRepos).values({ workspaceId, projectId, repoId: repo.id });
    }
    return repo.id;
  };

  const seedRun = async (repoId: string, sha: string, finishedAt: Date) => {
    const commit = expectOne(
      await t.db
        .insert(commits)
        .values({
          repoId,
          sha,
          branch: 'main',
          message: `deploy ${sha}`,
          authorName: 'Ada',
          authorEmail: 'ada@acme.test',
          committedAt: finishedAt,
        })
        .returning(),
    );
    const config = expectOne(
      await t.db
        .insert(commitConfigs)
        .values({ commitId: commit.id, rawYaml: 'version: 1', parsedJson: { version: 1 }, valid: true })
        .returning(),
    );
    await t.db.insert(runs).values({
      workspaceId,
      commitId: commit.id,
      commitConfigId: config.id,
      callbackTokenHash: randomUUID(),
      state: 'succeeded',
      createdAt: finishedAt,
      finishedAt,
    });
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    archiveFetches = [];
    domain = createFlagsDomain(t.db, {
      audit,
      approvals: createApprovalService(t.db, audit),
      archives: {
        getArchiveAtCommit: async (_ref, sha) => {
          archiveFetches.push(sha);
          return await archiveOf('src/app.ts', "if (await flags.getBooleanValue('checkout', false)) {}");
        },
      },
    });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'App', handle: 'app' });
    projectId = project.id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test` })
        .returning(),
    ).id;
    const environment = await domain.flags.createEnvironment(workspaceId, projectId, userId, {
      key: 'production',
      name: 'Production',
    });
    environmentId = environment.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('interleaves changesets with the linked pipeline runs, newest first', async () => {
    const repoId = await seedRepo(true);
    await seedRun(repoId, 'aaa111', new Date('2026-01-01T00:00:00Z'));
    await domain.flags.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'checkout',
      description: null,
      lifecycle: 'temporary',
    });
    await seedRun(repoId, 'bbb222', new Date('2999-01-01T00:00:00Z'));

    const unlinked = await domain.flags.timeline(workspaceId, projectId, environmentId);
    await domain.flags.setLinkedPipeline(workspaceId, projectId, userId, { environmentId, repoId });
    const linked = await domain.flags.timeline(workspaceId, projectId, environmentId);

    expect(unlinked.map(entry => entry.kind)).toEqual(['changeset']);
    expect(
      linked.map(entry =>
        entry.kind === 'run' ? `run ${entry.run.commitSha}` : `changeset v${entry.changeset.appliedVersion}`,
      ),
    ).toEqual(['run bbb222', 'changeset v1', 'run aaa111']);
  });

  it("refuses a repo the project doesn't link, and unlinks", async () => {
    const foreign = await seedRepo(false);
    const linked = await seedRepo(true);

    await expect(
      domain.flags.setLinkedPipeline(workspaceId, projectId, userId, { environmentId, repoId: foreign }),
    ).rejects.toBeInstanceOf(InvalidChangeError);
    await domain.flags.setLinkedPipeline(workspaceId, projectId, userId, { environmentId, repoId: linked });
    await domain.flags.setLinkedPipeline(workspaceId, projectId, userId, { environmentId, repoId: null });

    const [environment] = await domain.flags.listEnvironments(workspaceId, projectId);
    expect(environment?.linkedRepoId).toBeNull();
  });

  it('warns when the last deployed commit does not quote the flag key, and caches the scan', async () => {
    const check = async (flagKey: string) =>
      await domain.flags.deployCheck(workspaceId, projectId, environmentId, flagKey);
    await domain.flags.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'checkout',
      description: null,
      lifecycle: 'temporary',
    });
    await domain.flags.createBooleanFlag(workspaceId, projectId, userId, {
      key: 'onboarding',
      description: null,
      lifecycle: 'temporary',
    });
    const unlinked = await check('checkout');
    const repoId = await seedRepo(true);
    await domain.flags.setLinkedPipeline(workspaceId, projectId, userId, { environmentId, repoId });
    const noDeploy = await check('checkout');
    await seedRun(repoId, 'ccc333', new Date('2026-02-01T00:00:00Z'));

    const present = await check('checkout');
    const absent = await check('onboarding');

    expect([unlinked.state, noDeploy.state]).toEqual(['unlinked', 'no_deploy']);
    expect(present).toMatchObject({ state: 'present', commitSha: 'ccc333', repo: 'acme/app' });
    expect(absent).toMatchObject({ state: 'absent', commitSha: 'ccc333' });
    // One download: the second key was scanned with the first.
    expect(archiveFetches).toEqual(['ccc333']);
  });
});
