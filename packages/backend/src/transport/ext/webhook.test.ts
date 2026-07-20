import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { CommitConfigService } from '@backend/domain/integration/CommitConfigService';
import { CommitSyncService } from '@backend/domain/integration/CommitSyncService';
import { ConnectionService } from '@backend/domain/integration/ConnectionService';
import { ConnectionStatuses } from '@backend/domain/integration/constants';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { ConnectStateRepo } from '@backend/domain/integration/repos/connect-state.repo';
import { ProviderConnectionRepo } from '@backend/domain/integration/repos/provider-connection.repo';
import { RepoRepo } from '@backend/domain/integration/repos/repo.repo';
import { WebhookDeliveryRepo } from '@backend/domain/integration/repos/webhook-delivery.repo';
import { MoccoConfigParser } from '@backend/domain/pipeline/MoccoConfigParser';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';
import { providerConnections, repos, webhookDeliveries, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createExtApp, type ExtDeps } from '@backend/transport/ext/app';

import type { GitHubProvider } from '@backend/domain/integration/github/provider';
import type { CommitSource } from '@backend/domain/integration/ports';
import type { AvailableRepoDto } from '@mocco/common/integration';

// Fixtures recorded next to the GitHub adapter (Task 5). The push fixture carries
// installation.id = 12345678, repository.id = 654321, ref = refs/heads/main; the
// deleted fixture carries the same installation id. Seed data below mirrors these.
function readFixture(name: string): string {
  // Synchronous read is intentional: tiny fixtures loaded once at module scope,
  // not a hot path (mirrors domain/integration/github/webhook.test.ts).
  // eslint-disable-next-line n/no-sync
  return readFileSync(fileURLToPath(new URL(`../../domain/integration/testdata/${name}`, import.meta.url)), 'utf8');
}
const PUSH_BODY = readFixture('push.json');
const DELETED_BODY = readFixture('installation-deleted.json');

const INSTALLATION_ID = '12345678';
const REPO_EXTERNAL_ID = '654321';
const PUSH_SHA = '1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d';
const SECRET = 'webhook-test-secret';

const REPO_A: AvailableRepoDto = { externalRepoId: '111', owner: 'fi-workers', name: 'api', defaultBranch: 'main' };

/** Plain object implementing GitHubProvider — the webhook route never calls it. */
function fakeProvider(): GitHubProvider {
  return {
    listRepos: async () => [REPO_A],
    verifyOwnership: async () => ({ ownerVerified: true, accountLogin: 'acme', githubUserId: '77' }),
    installUrl: state => `https://example.test/install?state=${state}`,
    listCommits: async () => [],
    getConfigAtCommit: async () => null,
  };
}

/** CommitSource port — push handling never reaches it (only backfill does). */
const fakeSource: CommitSource = { listCommits: async () => [], getConfigAtCommit: async () => null };

const parser = new MoccoConfigParser(decodeYaml);

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) {
    throw new Error('expected one row');
  }
  return row;
}

async function post(app: ReturnType<typeof createExtApp>, body: string, headers: Record<string, string>) {
  return await app.request('/api/ext/github/webhook', { method: 'POST', body, headers });
}

function pushHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-github-event': 'push',
    'x-github-delivery': randomUUID(),
    'x-hub-signature-256': sign(PUSH_BODY),
    ...overrides,
  };
}

describe('ext GitHub webhook route (pglite)', () => {
  let t: TestDb;
  let pending: Promise<unknown>[];

  beforeEach(async () => {
    t = await createTestDb();
    pending = [];
  });
  afterEach(async () => {
    await t.close();
  });

  /** Build ExtDeps against the pglite db; `waitUntil` collects deferred promises so
   * the fire-and-forget sync is observable without vi.mock. */
  function deps(overrides: Partial<ExtDeps> = {}): ExtDeps {
    const connections = new ProviderConnectionRepo(t.db);
    const repoRepo = new RepoRepo(t.db);
    const connectStates = new ConnectStateRepo(t.db);
    return {
      auth: new AuthService(createProvider(t.db, { secret: 'test-secret-not-for-prod' })),
      connection: new ConnectionService({ connections, repos: repoRepo, connectStates, provider: fakeProvider() }),
      provider: fakeProvider(),
      commitSync: new CommitSyncService({
        commits: new CommitRepo(t.db),
        deliveries: new WebhookDeliveryRepo(t.db),
        connections,
        repos: repoRepo,
        connectStates,
        source: fakeSource,
        configs: new CommitConfigService({
          configs: new CommitConfigRepo(t.db),
          commits: new CommitRepo(t.db),
          source: fakeSource,
          parser,
        }),
      }),
      deliveries: new WebhookDeliveryRepo(t.db),
      webhookSecret: SECRET,
      waitUntil: p => {
        pending.push(p);
      },
      ...overrides,
    };
  }

  async function seedWatchedRepo(): Promise<string> {
    const workspaceId = one(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const conn = one(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: INSTALLATION_ID, accountLogin: 'acme' })
        .returning(),
    );
    const repo = one(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: conn.id,
          externalRepoId: REPO_EXTERNAL_ID,
          owner: 'fi-workers',
          name: 'example-repo',
          defaultBranch: 'main',
          watchedBranch: 'main',
        })
        .returning(),
    );
    return repo.id;
  }

  async function commitShas(repoId: string): Promise<Set<string>> {
    const rows = await new CommitRepo(t.db).listByRepo(repoId, null, 500);
    return new Set(rows.map(r => r.sha));
  }

  it('valid signature + push → 202 and commit rows written for the watched repo', async () => {
    const repoId = await seedWatchedRepo();
    const app = createExtApp(deps());

    const res = await post(app, PUSH_BODY, pushHeaders());
    expect(res.status).toBe(202);

    // Sync is deferred — nothing lands until the injected waitUntil promises settle.
    await Promise.all(pending);
    expect(await commitShas(repoId)).toEqual(new Set([PUSH_SHA]));
  });

  it('bad signature → 401 with zero delivery rows and zero commits', async () => {
    const repoId = await seedWatchedRepo();
    const app = createExtApp(deps());

    const res = await post(app, PUSH_BODY, pushHeaders({ 'x-hub-signature-256': sign(PUSH_BODY, 'wrong-secret') }));
    expect(res.status).toBe(401);

    await Promise.all(pending);
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(0);
    expect(await commitShas(repoId)).toEqual(new Set());
  });

  it('duplicate x-github-delivery → 202 with no second processing', async () => {
    const repoId = await seedWatchedRepo();
    const app = createExtApp(deps());
    const headers = pushHeaders(); // same delivery id on both requests

    const first = await post(app, PUSH_BODY, headers);
    const second = await post(app, PUSH_BODY, headers);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);

    // Only the first delivery schedules work; the redelivery short-circuits.
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(1);
    expect(await commitShas(repoId)).toEqual(new Set([PUSH_SHA]));
  });

  it('installation.deleted → 202 and the connection is soft-deleted', async () => {
    await seedWatchedRepo();
    const app = createExtApp(deps());

    const res = await post(app, DELETED_BODY, {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': sign(DELETED_BODY),
    });
    expect(res.status).toBe(202);

    await Promise.all(pending);
    const conn = one(
      await t.db.select().from(providerConnections).where(eq(providerConnections.externalAccountId, INSTALLATION_ID)),
    );
    expect(conn.status).toBe(ConnectionStatuses.deleted);
  });

  it('webhookSecret unset → 503, no writes', async () => {
    await seedWatchedRepo();
    const app = createExtApp(deps({ webhookSecret: undefined }));

    const res = await post(app, PUSH_BODY, pushHeaders());
    expect(res.status).toBe(503);
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(0);
  });

  it('valid signature + schema-invalid body → 202 (never 500), and the deferred parse failure is parked, not thrown', async () => {
    await seedWatchedRepo();
    const app = createExtApp(deps());

    // Signature-valid, but `action` is outside the zod enum — parseWebhook throws
    // WebhookParseError. That must happen only inside the deferred waitUntil work,
    // never on the request path, so the route still acks 202 immediately.
    const invalidBody = JSON.stringify({
      action: 'renamed',
      installation: { id: 12_345_678, account: { login: 'fi-workers', id: 999 } },
      sender: { login: 'octocat', id: 1 },
    });
    const res = await post(app, invalidBody, {
      'content-type': 'application/json',
      'x-github-event': 'installation',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': sign(invalidBody),
    });
    expect(res.status).toBe(202);

    // The delivery id was still recorded (dedup boundary), but the deferred parse+handle
    // must catch its own failure internally — awaiting the injected waitUntil promise
    // must not reject, and no commit rows are ever written for this event.
    await Promise.all(pending);
    expect(await t.db.select().from(webhookDeliveries)).toHaveLength(1);
  });
});
