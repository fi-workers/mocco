import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ComponentImpacts,
  ComponentStatuses,
  IncidentSeverities,
  IncidentStatuses,
  IncidentVisibilities,
} from '@mocco/common/status';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { PostgresJobQueue } from '@backend/domain/jobs/PostgresJobQueue';
import { JobRepo } from '@backend/domain/jobs/repos/job.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createSnapshotService, createStatusDomain } from '@backend/domain/status/compose';
import { StatusJobKinds } from '@backend/domain/status/jobs';
import { IncidentComponentRepo } from '@backend/domain/status/repos/incident-component.repo';
import { IncidentUpdateRepo } from '@backend/domain/status/repos/incident-update.repo';
import { IncidentRepo } from '@backend/domain/status/repos/incident.repo';
import { escapeHtml } from '@backend/domain/status/snapshot/render';
import { SnapshotPolicy } from '@backend/domain/status/SnapshotService';
import { StatusCacheControls } from '@backend/domain/status/StaticPublisher';
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { expectOne } from '@backend/infra/db/rows';
import { jobs, statusPages, statusPageSnapshots, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createJobRunner } from '@backend/runtime/jobs';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';
import type { SnapshotService } from '@backend/domain/status/SnapshotService';
import type { ObjectStore } from '@backend/domain/storage/ports';

const T0 = new Date('2026-10-05T09:00:00.000Z');

/** The filesystem driver, recording each put's key and cache control, and failing while `isDown`. */
class RecordingStore extends FilesystemObjectStore {
  readonly puts: { key: string; cacheControl: string | undefined; contentType: string }[] = [];

  isDown = false;

  override async put(...args: Parameters<ObjectStore['put']>) {
    if (this.isDown) {
      throw new Error('store unavailable');
    }
    const [key, , opts] = args;
    this.puts.push({ key, cacheControl: opts.cacheControl, contentType: opts.contentType });
    return await super.put(...args);
  }
}

describe('status snapshots (pglite)', () => {
  let t: TestDb;
  let root: string;
  let store: RecordingStore;
  let status: StatusDomain;
  let snapshots: SnapshotService;
  let scope: StatusScope;
  let actor: string;
  let clock: Date;

  const file = async (relative: string) =>
    // eslint-disable-next-line sonarjs/null-dereference -- relative is a string, never null
    await readFile(path.join(root, 'pub', 'status', ...relative.split('/')), 'utf8');

  const page = async (pageId: string) =>
    expectOne(await t.db.select().from(statusPages).where(eq(statusPages.id, pageId)));

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    root = await mkdtemp(path.join(tmpdir(), 'mocco-status-'));
    store = new RecordingStore({
      root,
      baseUrl: 'https://mocco.test/api/ext/internal/storage',
      signer: new StorageUrlSigner('test-signing-key'),
    });
    const queue = new PostgresJobQueue({
      jobs: new JobRepo(t.db),
      now: () => clock,
      runOne: async () => {},
      waitUntil: () => {},
    });
    const now = () => clock;
    status = createStatusDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), queue, now });
    const service = createSnapshotService(t.db, { store, queue, now });
    if (service === undefined) {
      throw new Error('a store was given');
    }
    snapshots = service;
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    actor = expectOne(await t.db.insert(users).values({ email: 'ada@acme.test', name: 'Ada' }).returning()).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
  });
  afterEach(async () => {
    await t.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A page with a grouped and an ungrouped component. */
  const setUp = async () => {
    const created = await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme status' });
    const group = await status.statusPages.createGroup(scope, created.id, { name: 'Core' });
    const api = await status.statusPages.createComponent(scope, created.id, { name: 'API', groupId: group.id });
    const web = await status.statusPages.createComponent(scope, created.id, { name: 'Dashboard' });
    return { page: created, api, web };
  };

  it('marks the page dirty with each change and requests one publish job for it', async () => {
    const { page: created, api } = await setUp();
    await status.statusPages.setComponentStatus(scope, actor, api.id, ComponentStatuses.degraded);

    expect(await page(created.id)).toMatchObject({ dirtyAt: T0 });
    const queued = await t.db.select().from(jobs).where(eq(jobs.kind, StatusJobKinds.snapshotPublish));
    expect(queued.map(job => job.payload)).toEqual([{ pageId: created.id }]);
  });

  it('uploads the version first and flips the pointer last, with the cache headers', async () => {
    const { page: created } = await setUp();

    expect(await snapshots.publish(created.id)).toBe(1);

    expect(store.puts.at(-1)).toMatchObject({
      key: 'pub/status/acme/current.json',
      cacheControl: StatusCacheControls.pointer,
    });
    const immutable = store.puts.filter(put => put.key.startsWith('pub/status/acme/v/1/'));
    expect(new Set(immutable.map(put => put.key))).toEqual(
      new Set(['pub/status/acme/v/1/feed.atom', 'pub/status/acme/v/1/index.html', 'pub/status/acme/v/1/snapshot.json']),
    );
    expect(new Set(immutable.map(put => put.cacheControl))).toEqual(new Set([StatusCacheControls.immutable]));
    expect(store.puts.findIndex(put => put.key.endsWith('/index.html') && !put.key.includes('/v/'))).toBeGreaterThan(
      store.puts.findIndex(put => put.key.endsWith('v/1/index.html')),
    );
    expect(await store.meta('pub/status/acme/current.json')).toMatchObject({
      cacheControl: 'public, max-age=15, stale-while-revalidate=60, stale-if-error=604800',
      contentType: 'application/json',
    });

    const pointer: unknown = JSON.parse(await file('acme/current.json'));
    expect(pointer).toMatchObject({ version: 1, builtAt: T0.toISOString() });
    const snapshot: unknown = JSON.parse(await file('acme/v/1/snapshot.json'));
    expect(snapshot).toMatchObject({
      page: { slug: 'acme', title: 'Acme status' },
      status: ComponentStatuses.operational,
      sections: [
        { name: null, components: [{ name: 'Dashboard', uptime: null }] },
        { name: 'Core', components: [{ name: 'API' }] },
      ],
    });
    const html = await file('acme/index.html');
    expect(html).toContain('All systems operational');
    expect(html).toContain('No data yet');
    expect(await page(created.id)).toMatchObject({ dirtyAt: null, publishedVersion: 1, publishedAt: T0 });
    // Nothing changed: no new version.
    expect(await snapshots.publish(created.id)).toBe(1);
    expect(await t.db.select().from(statusPageSnapshots)).toHaveLength(1);
  });

  it('never publishes a draft incident, its impact, author emails or internal ids', async () => {
    const { page: created, api, web } = await setUp();
    const published = await status.statusIncidents.create(scope, actor, {
      pageId: created.id,
      title: 'Slow API',
      severity: IncidentSeverities.minor,
      status: IncidentStatuses.investigating,
      body: 'We are looking into it.',
      components: [{ componentId: api.id, impact: ComponentImpacts.degraded }],
    });
    // A draft (monitor-origin incidents start as drafts once monitors land).
    const draft = await new IncidentRepo(t.db).insert({
      ...scope,
      pageId: created.id,
      title: 'Secret draft outage',
      severity: IncidentSeverities.critical,
      status: IncidentStatuses.investigating,
      visibility: IncidentVisibilities.draft,
      createdByUserId: actor,
    });
    await new IncidentUpdateRepo(t.db).insert({
      workspaceId: scope.workspaceId,
      incidentId: draft.id,
      status: IncidentStatuses.investigating,
      bodyMd: 'draft body',
      authorUserId: actor,
    });
    await new IncidentComponentRepo(t.db).replace(scope.workspaceId, draft.id, [
      { componentId: web.id, impact: ComponentImpacts.majorOutage },
    ]);

    await snapshots.publish(created.id);

    const files = await Promise.all(
      ['acme/v/1/snapshot.json', 'acme/index.html', 'acme/feed.atom'].map(async name => await file(name)),
    );
    expect(files).toEqual(Array.from({ length: 3 }, () => expect.stringContaining('Slow API')));
    const everything = files.join('\n');
    const forbidden = ['Secret draft outage', 'draft body', 'ada@acme.test', published.id, draft.id, actor];
    const ids = [scope.workspaceId, scope.projectId, created.id];
    expect([...forbidden, ...ids].filter(text => everything.includes(text))).toEqual([]);
    const snapshot = JSON.parse(files[0] ?? '') as { status: string; incidents: unknown[] };
    // Only the published incident's impact counts: the draft's major outage on Dashboard doesn't show.
    expect(snapshot.status).toBe(ComponentStatuses.degraded);
    expect(snapshot.incidents).toHaveLength(1);
  });

  it('escapes customer text in the page and the feed', async () => {
    const created = await status.statusPages.createPage(scope, actor, {
      slug: 'acme',
      title: '<script>alert(1)</script>',
    });
    await status.statusIncidents.create(scope, actor, {
      pageId: created.id,
      title: 'A & B <img src=x onerror=alert(1)>',
      severity: IncidentSeverities.major,
      status: IncidentStatuses.identified,
      body: '"quoted" <b>bold</b>',
      components: [],
    });

    await snapshots.publish(created.id);

    const [html, feed] = [await file('acme/index.html'), await file('acme/feed.atom')];
    const raw = ['<script>alert(1)</script>', '<img src=x', '<b>bold</b>'];
    expect(raw.filter(text => html.includes(text) || feed.includes(text))).toEqual([]);
    expect(html).toContain(escapeHtml('A & B <img src=x onerror=alert(1)>'));
    expect(feed).toContain(escapeHtml('A & B <img src=x onerror=alert(1)>'));
  });

  it('clears a mark set in SQL with microseconds, so the page is built once', async () => {
    const { page: created } = await setUp();
    await t.db.execute(
      sql`update mocco_status_pages set dirty_at = '2026-10-05 08:59:59.123456' where id = ${created.id}`,
    );

    expect(await snapshots.publish(created.id)).toBe(1);

    expect(await page(created.id)).toMatchObject({ dirtyAt: null, publishedVersion: 1 });
  });

  it('records a failed upload, keeps the page dirty-free, and the safety run retries it', async () => {
    const { page: created } = await setUp();
    store.isDown = true;

    expect(await snapshots.publish(created.id)).toBeNull();

    const [failed] = await t.db.select().from(statusPageSnapshots);
    expect(failed).toMatchObject({ version: 1, uploadedAt: null, uploadError: 'store unavailable' });
    expect(await page(created.id)).toMatchObject({ publishedVersion: null });

    await t.db.delete(jobs);
    expect(await snapshots.sweep()).toBe(1);
    expect(await t.db.select({ payload: jobs.payload }).from(jobs)).toEqual([{ payload: { pageId: created.id } }]);

    store.isDown = false;
    expect(await snapshots.publish(created.id)).toBe(1);
    expect(await t.db.select().from(statusPageSnapshots)).toEqual([
      expect.objectContaining({ version: 1, uploadError: null, uploadedAt: T0 }),
    ]);
    expect(await snapshots.sweep()).toBe(0);
  });

  it(`keeps the newest ${SnapshotPolicy.keepVersions} versions and deletes older files`, async () => {
    const { page: created, api } = await setUp();
    const statuses = [ComponentStatuses.degraded, ComponentStatuses.operational];
    for (let n = 0; n < SnapshotPolicy.keepVersions + 2; n += 1) {
      // eslint-disable-next-line no-await-in-loop -- each version builds on the previous one
      await status.statusPages.setComponentStatus(scope, actor, api.id, statuses[n % 2] ?? ComponentStatuses.degraded);
      // eslint-disable-next-line no-await-in-loop -- see above
      await snapshots.publish(created.id);
    }

    const versions = await t.db.select({ version: statusPageSnapshots.version }).from(statusPageSnapshots);
    expect(versions.map(row => row.version).toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: SnapshotPolicy.keepVersions }, (_, index) => index + 3),
    );
    expect(await store.head('pub/status/acme/v/2/snapshot.json')).toBeNull();
    expect(await store.head('pub/status/acme/v/3/snapshot.json')).not.toBeNull();
  });

  it('publishes through the job runner', async () => {
    const { page: created } = await setUp();
    const runner = createJobRunner(t.db, {
      now: () => T0,
      random: () => 0,
      workerId: 'test',
      waitUntil: () => {},
      appOrigin: 'https://mocco.test',
      discord: undefined,
      storage: new StorageService({ objects: new ObjectRepo(t.db), store }),
    });

    const report = await runner.tick({ budgetMs: 10_000, maxJobs: 50 });

    expect(report.errors).toEqual([]);
    expect(await page(created.id)).toMatchObject({ publishedVersion: 1, dirtyAt: null });
    expect(JSON.parse(await file('acme/current.json'))).toMatchObject({ version: 1 });
  });
});
