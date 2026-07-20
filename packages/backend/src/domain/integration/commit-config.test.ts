import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommitConfigService } from '@backend/domain/integration/CommitConfigService';
import { CommitNotFoundError } from '@backend/domain/integration/errors';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { MoccoConfigParser } from '@backend/domain/pipeline/MoccoConfigParser';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';
import { commitConfigs, providerConnections, repos, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { CommitSource } from '@backend/domain/integration/ports';

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected one row');
  }
  return row;
}

type Ref = Parameters<CommitSource['getConfigAtCommit']>[0];

const REF: Ref = { externalAccountId: '900', owner: 'fi-workers', name: 'api' };

const VALID_YAML = `version: 1
pipeline: deploy
steps:
  - run: build
    executor: generic`;

const INVALID_YAML = `version: 1
pipeline: deploy
steps: []`; // schema rejects an empty steps array

/** Plain object implementing the CommitSource port — canned content keyed by sha,
 * `undefined` in the map means "not registered" (test bug), `null` means "absent". */
function fakeSource(bySha: Record<string, string | null>): CommitSource & { calls: string[] } {
  const source = {
    calls: [] as string[],
    listCommits: async () => [],
    getConfigAtCommit: async (_ref: Ref, sha: string) => {
      source.calls.push(sha);
      if (!Object.hasOwn(bySha, sha)) {
        throw new Error(`fakeSource: unregistered sha ${sha}`);
      }
      return bySha[sha] ?? null;
    },
  };
  return source;
}

/** A source whose getConfigAtCommit throws for specific shas — proves per-commit isolation. */
function flakySource(failingShas: Set<string>, ok: Record<string, string | null>): CommitSource {
  return {
    listCommits: async () => [],
    getConfigAtCommit: async (_ref: Ref, sha: string) => {
      if (failingShas.has(sha)) {
        throw new Error(`boom: ${sha}`);
      }
      return ok[sha] ?? null;
    },
  };
}

describe('CommitConfigService (pglite)', () => {
  let t: TestDb;
  let commits: CommitRepo;
  let configs: CommitConfigRepo;
  const parser = new MoccoConfigParser(decodeYaml);

  beforeEach(async () => {
    t = await createTestDb();
    commits = new CommitRepo(t.db);
    configs = new CommitConfigRepo(t.db);
  });

  afterEach(async () => {
    await t.close();
  });

  function service(source: CommitSource): CommitConfigService {
    return new CommitConfigService({
      configs,
      commits,
      repos: new RepoRepo(t.db),
      source,
      parser,
    });
  }

  async function seedWorkspace(name = 'W'): Promise<string> {
    return one(await t.db.insert(workspaces).values({ name, slug: randomUUID() }).returning()).id;
  }

  async function seedRepo(workspaceId: string) {
    const conn = one(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    return one(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: conn.id,
          externalRepoId: randomUUID(),
          owner: 'fi-workers',
          name: 'api',
          defaultBranch: 'main',
        })
        .returning(),
    );
  }

  async function seedCommit(repoId: string, sha: string) {
    await commits.upsertMany([
      {
        repoId,
        sha,
        branch: 'main',
        message: `msg ${sha}`,
        authorName: 'Author',
        authorEmail: 'author@example.com',
        committedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const [row] = await commits.listByRepo(repoId, null, 1);
    if (row === undefined) {
      throw new Error('expected seeded commit row');
    }
    return row;
  }

  it('snapshotCommit stores a valid config: valid:true and the parsed config', async () => {
    const workspaceId = await seedWorkspace();
    const repo = await seedRepo(workspaceId);
    const commit = await seedCommit(repo.id, 'sha-valid');
    const svc = service(fakeSource({ 'sha-valid': VALID_YAML }));

    await svc.snapshotCommit(REF, commit);

    const row = await configs.findByCommitId(commit.id);
    expect(row?.valid).toBe(true);
    expect(row?.rawYaml).toBe(VALID_YAML);
    expect(row?.parsedJson).toMatchObject({ pipeline: 'deploy' });
    expect(row?.validationErrors).toEqual([]);
  });

  it('snapshotCommit stores an invalid config: valid:false and the issues', async () => {
    const workspaceId = await seedWorkspace();
    const repo = await seedRepo(workspaceId);
    const commit = await seedCommit(repo.id, 'sha-invalid');
    const svc = service(fakeSource({ 'sha-invalid': INVALID_YAML }));

    await svc.snapshotCommit(REF, commit);

    const row = await configs.findByCommitId(commit.id);
    expect(row?.valid).toBe(false);
    expect(row?.parsedJson).toBeNull();
    expect(Array.isArray(row?.validationErrors)).toBe(true);
    expect((row?.validationErrors as unknown[]).length).toBeGreaterThan(0);
  });

  // Documents the current, deliberately limited handling of an absent `.mocco.yml`.
  // The `mocco_commit_configs` table has no `present` column (see CommitConfigService
  // doc comment) — this test locks in today's behavior (no row stored) rather than a
  // fragile heuristic. A follow-up schema change is needed for full DTO conformance.
  it('snapshotCommit does not store a row when the source has no config at that commit (absent)', async () => {
    const workspaceId = await seedWorkspace();
    const repo = await seedRepo(workspaceId);
    const commit = await seedCommit(repo.id, 'sha-absent');
    const svc = service(fakeSource({ 'sha-absent': null }));

    await svc.snapshotCommit(REF, commit);

    expect(await configs.findByCommitId(commit.id)).toBeUndefined();
  });

  it('re-snapshot overwrites: a later snapshotCommit call replaces the prior row', async () => {
    const workspaceId = await seedWorkspace();
    const repo = await seedRepo(workspaceId);
    const commit = await seedCommit(repo.id, 'sha-resnap');
    const source: CommitSource & { current: string | null } = {
      current: INVALID_YAML,
      listCommits: async () => [],
      getConfigAtCommit: async () => source.current,
    };
    const svc = service(source);

    await svc.snapshotCommit(REF, commit);
    const first = await configs.findByCommitId(commit.id);
    expect(first?.valid).toBe(false);

    source.current = VALID_YAML;
    await svc.snapshotCommit(REF, commit);

    const row = await configs.findByCommitId(commit.id);
    expect(row?.valid).toBe(true);
    expect(row?.rawYaml).toBe(VALID_YAML);
    const all = await t.db.select().from(commitConfigs);
    expect(all).toHaveLength(1); // still one row, not two
  });

  it('snapshotForCommits processes every commit in the batch', async () => {
    const workspaceId = await seedWorkspace();
    const repo = await seedRepo(workspaceId);
    const c1 = await seedCommit(repo.id, 'sha-1');
    const c2 = await seedCommit(repo.id, 'sha-2');
    const svc = service(fakeSource({ 'sha-1': VALID_YAML, 'sha-2': null }));

    await svc.snapshotForCommits(REF, [c1, c2]);

    const row1 = await configs.findByCommitId(c1.id);
    expect(row1?.valid).toBe(true);
    expect(await configs.findByCommitId(c2.id)).toBeUndefined();
  });

  it('snapshotForCommits: a fetch failure for one commit does not sink the rest of the batch', async () => {
    const workspaceId = await seedWorkspace();
    const repo = await seedRepo(workspaceId);
    const ok = await seedCommit(repo.id, 'sha-ok');
    const broken = await seedCommit(repo.id, 'sha-broken');
    const svc = service(flakySource(new Set(['sha-broken']), { 'sha-ok': VALID_YAML }));

    await expect(svc.snapshotForCommits(REF, [broken, ok])).resolves.toBeUndefined();

    expect(await configs.findByCommitId(broken.id)).toBeUndefined();
    const okRow = await configs.findByCommitId(ok.id);
    expect(okRow?.valid).toBe(true);
  });

  it('getDetail returns the commit and its snapshotted config', async () => {
    const workspaceId = await seedWorkspace();
    const repo = await seedRepo(workspaceId);
    const commit = await seedCommit(repo.id, 'sha-detail');
    const svc = service(fakeSource({ 'sha-detail': VALID_YAML }));
    await svc.snapshotCommit(REF, commit);

    const detail = await svc.getDetail(workspaceId, commit.id);

    expect(detail.commit.id).toBe(commit.id);
    expect(detail.commit.sha).toBe('sha-detail');
    expect(detail.config).not.toBeNull();
    expect(detail.config?.valid).toBe(true);
    expect(detail.config?.present).toBe(true);
    expect(detail.config?.config).toMatchObject({ pipeline: 'deploy' });
  });

  it('getDetail returns config:null when the commit has not been snapshotted yet', async () => {
    const workspaceId = await seedWorkspace();
    const repo = await seedRepo(workspaceId);
    const commit = await seedCommit(repo.id, 'sha-unsnapshotted');
    const svc = service(fakeSource({}));

    const detail = await svc.getDetail(workspaceId, commit.id);
    expect(detail.config).toBeNull();
  });

  it('getDetail throws CommitNotFoundError for a commit in another workspace', async () => {
    const workspaceA = await seedWorkspace('A');
    const workspaceB = await seedWorkspace('B');
    const repoA = await seedRepo(workspaceA);
    await seedRepo(workspaceB);
    const commit = await seedCommit(repoA.id, 'sha-tenant');
    const svc = service(fakeSource({}));

    await expect(svc.getDetail(workspaceB, commit.id)).rejects.toBeInstanceOf(CommitNotFoundError);
  });
});
