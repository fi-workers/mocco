// The embedded probe end to end on pglite: the server's own ProbeService leases a round to the
// `embedded` location, @mocco/probe's loop checks a local HTTP target, reports, and the
// evaluator moves the monitor. Plus the start rules: once per process, never on Vercel.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { LocationKinds, MonitorKinds, MonitorStates, monitorInputSchema } from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain, type StatusDomain } from '@backend/domain/status/compose';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import { statusCheckResults, statusLocations, statusMonitors, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { EMBEDDED_AGENT_VERSION, runEmbeddedProbe } from '@backend/runtime/probe';

import type { AddressInfo } from 'node:net';

const quiet = { info: () => undefined, warn: () => undefined };
const FAST = { maxJitterMs: 0, flushDelayMs: 10, heartbeatIntervalMs: 50, backoffBaseMs: 20, backoffMaxMs: 200 };
/** Waits on a condition, never a fixed sleep; generous so a slow runner only makes it slower. */
const WAIT = { timeout: 20_000, interval: 25 };

describe('embedded probe (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let target: Server;
  let targetUrl: string;
  let workspaceId: string;
  let projectId: string;
  let actor: string;

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    status = createStatusDomain(t.db, { audit });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    await new TimeSeriesRetention({ db: t.db }).run(new Date());
    target = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('healthy');
    });
    await new Promise<void>(resolve => {
      target.listen(0, '127.0.0.1', resolve);
    });
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/health`;
  });

  afterEach(async () => {
    target.closeAllConnections();
    await new Promise(resolve => {
      target.close(resolve);
    });
    await t.close();
  });

  const createMonitor = async (locationId: string) =>
    await status.statusMonitors.create(
      { workspaceId, projectId },
      actor,
      monitorInputSchema.parse({
        name: 'Local target',
        spec: { kind: MonitorKinds.http, url: targetUrl, keyword: 'healthy' },
        locationIds: [locationId],
      }),
    );

  it('creates one shared embedded location, however many callers race for it', async () => {
    const [first, second] = await Promise.all([
      status.statusLocations.ensureEmbedded(),
      status.statusLocations.ensureEmbedded(),
    ]);

    expect(first.id).toBe(second.id);
    expect(first).toMatchObject({ kind: LocationKinds.embedded, workspaceId: null, code: 'embedded' });
    expect(await t.db.select().from(statusLocations)).toHaveLength(1);
  });

  it('runs one round end to end: lease, check, report, verdict', async () => {
    const location = await status.statusLocations.ensureEmbedded();
    const monitor = await createMonitor(location.id);
    const controller = new AbortController();

    const running = runEmbeddedProbe(
      { probes: status.statusProbes, locations: status.statusLocations, concurrency: 2, log: quiet, timing: FAST },
      controller.signal,
    );
    await vi.waitFor(async () => {
      const [row] = await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, monitor.id));
      expect(row?.state).toBe(MonitorStates.up);
    }, WAIT);
    controller.abort();
    await running;

    const results = await t.db.select().from(statusCheckResults);
    expect(results).toEqual([
      expect.objectContaining({ monitorId: monitor.id, locationId: location.id, outcome: 'ok', statusCode: 200 }),
    ]);
    const [seen] = await t.db.select().from(statusLocations).where(eq(statusLocations.id, location.id));
    expect(seen).toMatchObject({ agentVersion: EMBEDDED_AGENT_VERSION, lastSeenAt: expect.any(Date) });
  });

  it('stays off when the embedded location is disabled', async () => {
    const location = await status.statusLocations.ensureEmbedded();
    await t.db.update(statusLocations).set({ disabledAt: new Date() }).where(eq(statusLocations.id, location.id));
    const lease = vi.spyOn(status.statusProbes, 'lease');

    await runEmbeddedProbe(
      { probes: status.statusProbes, locations: status.statusLocations, concurrency: 2, log: quiet, timing: FAST },
      new AbortController().signal,
    );

    expect(lease).not.toHaveBeenCalled();
  });
});

describe('ensureEmbeddedProbe', () => {
  const SLOT = Symbol.for('mocco.status.embeddedProbe');

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://not-used');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Reflect.deleteProperty(globalThis, SLOT);
  });

  it('does nothing unless STATUS_PROBE_EMBEDDED is set', async () => {
    const { ensureEmbeddedProbe } = await import('@backend/runtime/probe');

    expect(ensureEmbeddedProbe()).toBe('off');
    expect(Reflect.has(globalThis, SLOT)).toBe(false);
  });

  it('refuses on Vercel, every time, without starting anything', async () => {
    vi.stubEnv('STATUS_PROBE_EMBEDDED', 'true');
    vi.stubEnv('VERCEL_ENV', 'production');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { ensureEmbeddedProbe } = await import('@backend/runtime/probe');

    expect(ensureEmbeddedProbe()).toBe('refused_on_vercel');
    expect(ensureEmbeddedProbe()).toBe('refused_on_vercel');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
