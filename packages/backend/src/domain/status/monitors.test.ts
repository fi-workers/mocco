import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import {
  ComponentStatuses,
  LocationKinds,
  MonitorKinds,
  MonitorStates,
  monitorInputSchema,
} from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { LocationCodeTakenError, StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { hashLocationToken } from '@backend/domain/status/location-token';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { MonitorRepo } from '@backend/domain/status/repos/monitor.repo';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  statusLocations,
  statusMonitorLocations,
  statusMonitors,
  statusMonitorStateChanges,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';
import type { MonitorInput } from '@mocco/common/status';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** A monitor input with the schema's defaults applied, as the router hands it to the service. */
const httpMonitor = (locationIds: string[], extra: Partial<MonitorInput> = {}): MonitorInput =>
  monitorInputSchema.parse({
    name: 'API health',
    spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health' },
    locationIds,
    ...extra,
  });

describe('monitors and locations (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let scope: StatusScope;
  let otherScope: StatusScope;
  let actor: string;
  let clock: Date;

  const actions = async () => {
    const rows = await t.db.select({ action: auditLog.action }).from(auditLog).orderBy(auditLog.seq);
    return rows.map(row => row.action);
  };

  const newScope = async (handle: string): Promise<StatusScope> => {
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: handle, slug: randomUUID() }).returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: handle, handle });
    return { workspaceId, projectId: project.id };
  };

  /** A shared location, as the hosted fleet's provisioning will insert it. */
  const hosted = async (code: string, disabledAt: Date | null = null) =>
    await new LocationRepo(t.db).insert({
      workspaceId: null,
      code,
      name: `Hosted ${code}`,
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(randomUUID()),
      disabledAt,
    });

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    status = createStatusDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), now: () => clock });
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    scope = await newScope('acme');
    otherScope = await newScope('other');
  });
  afterEach(async () => {
    await t.close();
  });

  describe('locations', () => {
    it('returns a private location token once and stores only its SHA-256 hash', async () => {
      const { location, token } = await status.statusLocations.create(scope.workspaceId, actor, {
        code: 'office',
        name: 'Office',
      });

      expect(token).toMatch(/^mpl_[\w-]{43}$/);
      expect(location).toMatchObject({ kind: LocationKinds.private, workspaceId: scope.workspaceId });
      const [row] = await t.db.select().from(statusLocations).where(eq(statusLocations.id, location.id));
      expect(row?.tokenHash).toBe(hashLocationToken(token));
      expect(JSON.stringify(row)).not.toContain(token);

      const rotated = await status.statusLocations.rotateToken(scope.workspaceId, actor, location.id);
      expect(rotated.token).not.toBe(token);
      expect(rotated.location.tokenHash).toBe(hashLocationToken(rotated.token));
      expect(await actions()).toEqual([AuditActions.statusLocationCreated, AuditActions.statusLocationTokenRotated]);
    });

    it('refuses a code the workspace already uses, but another workspace may reuse it', async () => {
      await status.statusLocations.create(scope.workspaceId, actor, { code: 'office', name: 'Office' });

      await expect(
        status.statusLocations.create(scope.workspaceId, actor, { code: 'office', name: 'Again' }),
      ).rejects.toBeInstanceOf(LocationCodeTakenError);
      await expect(
        status.statusLocations.create(otherScope.workspaceId, actor, { code: 'office', name: 'Theirs' }),
      ).resolves.toMatchObject({ location: { code: 'office' } });
    });

    it('lists enabled hosted locations and only the workspace’s own private ones', async () => {
      await hosted('fra');
      await hosted('iad', T0);
      const own = await status.statusLocations.create(scope.workspaceId, actor, { code: 'office', name: 'Office' });
      await status.statusLocations.create(otherScope.workspaceId, actor, { code: 'theirs', name: 'Theirs' });

      const listed = await status.statusLocations.list(scope.workspaceId);

      expect(listed.map(row => row.code)).toEqual(['fra', 'office']);
      await expect(
        status.statusLocations.rotateToken(otherScope.workspaceId, actor, own.location.id),
      ).rejects.toBeInstanceOf(StatusEntityNotFoundError);
      await expect(
        status.statusLocations.disable(otherScope.workspaceId, actor, own.location.id),
      ).rejects.toBeInstanceOf(StatusEntityNotFoundError);
    });

    it('lets the DB hold only private locations in a workspace', async () => {
      await expect(
        t.db.insert(statusLocations).values({
          workspaceId: scope.workspaceId,
          code: 'fra',
          name: 'FRA',
          kind: LocationKinds.hosted,
          tokenHash: 'x',
        }),
      ).rejects.toThrow();
      await expect(
        t.db.insert(statusLocations).values({ code: 'x', name: 'X', kind: LocationKinds.private, tokenHash: 'y' }),
      ).rejects.toThrow();
    });
  });

  describe('monitors', () => {
    it('creates a pending monitor due now on hosted and own locations, with its components', async () => {
      const fra = await hosted('fra');
      const { location: office } = await status.statusLocations.create(scope.workspaceId, actor, {
        code: 'office',
        name: 'Office',
      });
      const page = await status.statusPages.createPage(scope, actor, { slug: 'acme', title: 'Acme' });
      const api = await status.statusPages.createComponent(scope, page.id, { name: 'API' });

      const monitor = await status.statusMonitors.create(
        scope,
        actor,
        httpMonitor([fra.id, office.id, fra.id], {
          components: [{ componentId: api.id, impactWhenDown: ComponentStatuses.majorOutage }],
        }),
      );

      expect(monitor).toMatchObject({
        kind: MonitorKinds.http,
        state: MonitorStates.pending,
        nextRoundAt: T0,
        intervalSeconds: 60,
        confirmations: 2,
        recoveryConfirmations: 2,
        quorumMode: 'majority',
        spec: { kind: MonitorKinds.http, method: 'GET', expectedStatus: [], timeoutMs: 10_000, followRedirects: true },
      });
      const { monitor: detail, stateChanges } = await status.statusMonitors.get(scope, monitor.id);
      expect(new Set(detail.locationIds)).toEqual(new Set([fra.id, office.id]));
      expect(detail.components).toEqual([{ componentId: api.id, impactWhenDown: ComponentStatuses.majorOutage }]);
      expect(stateChanges).toEqual([]);
      expect(await actions()).toEqual([
        AuditActions.statusLocationCreated,
        AuditActions.statusPageCreated,
        AuditActions.statusMonitorCreated,
      ]);
    });

    it('refuses another workspace’s location, a disabled one and another project’s component', async () => {
      const { location: theirs } = await status.statusLocations.create(otherScope.workspaceId, actor, {
        code: 'theirs',
        name: 'Theirs',
      });
      const off = await hosted('iad', T0);
      const fra = await hosted('fra');
      const theirPage = await status.statusPages.createPage(otherScope, actor, { slug: 'theirs', title: 'Theirs' });
      const theirComponent = await status.statusPages.createComponent(otherScope, theirPage.id, { name: 'API' });

      await expect(status.statusMonitors.create(scope, actor, httpMonitor([theirs.id]))).rejects.toBeInstanceOf(
        StatusEntityNotFoundError,
      );
      await expect(status.statusMonitors.create(scope, actor, httpMonitor([off.id]))).rejects.toBeInstanceOf(
        StatusEntityNotFoundError,
      );
      await expect(
        status.statusMonitors.create(
          scope,
          actor,
          httpMonitor([fra.id], {
            components: [{ componentId: theirComponent.id, impactWhenDown: ComponentStatuses.degraded }],
          }),
        ),
      ).rejects.toBeInstanceOf(StatusEntityNotFoundError);
      expect(await t.db.select().from(statusMonitors)).toEqual([]);
    });

    it('replaces settings and links on update and keeps the state', async () => {
      const fra = await hosted('fra');
      const iad = await hosted('iad');
      const monitor = await status.statusMonitors.create(scope, actor, httpMonitor([fra.id]));
      await status.statusMonitors.pause(scope, actor, monitor.id);

      const updated = await status.statusMonitors.update(
        scope,
        actor,
        monitor.id,
        monitorInputSchema.parse({
          name: 'Database',
          spec: { kind: MonitorKinds.tcp, host: 'db.acme.test', port: 5432 },
          intervalSeconds: 300,
          locationIds: [iad.id],
        }),
      );

      expect(updated).toMatchObject({
        name: 'Database',
        kind: MonitorKinds.tcp,
        intervalSeconds: 300,
        state: MonitorStates.paused,
      });
      const { monitor: detail } = await status.statusMonitors.get(scope, monitor.id);
      expect(detail.locationIds).toEqual([iad.id]);
      await expect(
        status.statusMonitors.update(otherScope, actor, monitor.id, httpMonitor([fra.id])),
      ).rejects.toBeInstanceOf(StatusEntityNotFoundError);
    });

    it('pauses and resumes under the state lock, recording each change once', async () => {
      const fra = await hosted('fra');
      const monitor = await status.statusMonitors.create(scope, actor, httpMonitor([fra.id]));

      clock = minutes(5);
      const paused = await status.statusMonitors.pause(scope, actor, monitor.id);
      await status.statusMonitors.pause(scope, actor, monitor.id);
      clock = minutes(10);
      const resumed = await status.statusMonitors.resume(scope, actor, monitor.id);
      await status.statusMonitors.resume(scope, actor, monitor.id);

      expect(paused).toMatchObject({ state: MonitorStates.paused, stateChangedAt: minutes(5) });
      expect(resumed).toMatchObject({
        state: MonitorStates.pending,
        stateChangedAt: minutes(10),
        nextRoundAt: minutes(10),
      });
      const changes = await t.db.select().from(statusMonitorStateChanges).orderBy(statusMonitorStateChanges.at);
      expect(changes.map(row => [row.fromState, row.toState, row.at])).toEqual([
        [MonitorStates.pending, MonitorStates.paused, minutes(5)],
        [MonitorStates.paused, MonitorStates.pending, minutes(10)],
      ]);
      expect(changes[0]?.reason).toEqual({ by: 'operator', userId: actor });
      const recorded = await actions();
      expect(recorded.slice(1)).toEqual([AuditActions.statusMonitorPaused, AuditActions.statusMonitorResumed]);
      await expect(status.statusMonitors.pause(otherScope, actor, monitor.id)).rejects.toBeInstanceOf(
        StatusEntityNotFoundError,
      );
    });

    it('holds the monitor’s state lock for the transaction only', async () => {
      const fra = await hosted('fra');
      const monitor = await status.statusMonitors.create(scope, actor, httpMonitor([fra.id]));

      // The lock is transaction-scoped: it is held inside and gone after commit.
      const held = await t.db.transaction(async tx => {
        await new MonitorRepo(tx).lockForStateChange(scope, monitor.id);
        const { rows } = await tx.execute<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'",
        );
        return rows[0]?.count;
      });
      const { rows: after } = await t.db.execute<{ count: number }>(
        "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'",
      );

      expect(held).toBe(1);
      expect(after[0]?.count).toBe(0);
    });

    it('deletes a monitor with its links and history', async () => {
      const fra = await hosted('fra');
      const monitor = await status.statusMonitors.create(scope, actor, httpMonitor([fra.id]));
      await status.statusMonitors.pause(scope, actor, monitor.id);

      await expect(status.statusMonitors.delete(otherScope, actor, monitor.id)).rejects.toBeInstanceOf(
        StatusEntityNotFoundError,
      );
      await status.statusMonitors.delete(scope, actor, monitor.id);

      expect(await t.db.select().from(statusMonitors)).toEqual([]);
      expect(await t.db.select().from(statusMonitorLocations)).toEqual([]);
      expect(await t.db.select().from(statusMonitorStateChanges)).toEqual([]);
      const recorded = await actions();
      expect(recorded.at(-1)).toBe(AuditActions.statusMonitorDeleted);
    });

    it('rejects a sub-minute interval in zod and in the DB', async () => {
      const fra = await hosted('fra');
      expect(() => httpMonitor([fra.id], { intervalSeconds: 30 })).toThrow();
      await expect(
        t.db.insert(statusMonitors).values({
          ...scope,
          name: 'x',
          kind: MonitorKinds.http,
          spec: { kind: MonitorKinds.http, url: 'https://x.test' } as MonitorInput['spec'],
          intervalSeconds: 30,
          confirmations: 1,
          recoveryConfirmations: 1,
          quorumMode: 'any',
        }),
      ).rejects.toThrow();
    });
  });
});
