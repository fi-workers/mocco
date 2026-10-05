import { randomUUID } from 'node:crypto';

import {
  ComponentImpacts,
  ComponentStatuses,
  IncidentSeverities,
  IncidentStatuses,
  IncidentVisibilities,
  MaintenanceStatuses,
  MonitorKinds,
  monitorSpecSchema,
  MonitorStates,
  QuorumModes,
  RoundVerdicts,
} from '@mocco/common/status';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { CheckResultRepo } from '@backend/domain/status/repos/check-result.repo';
import { MonitorStateChangeRepo } from '@backend/domain/status/repos/monitor-state-change.repo';
import { RoundVerdictRepo } from '@backend/domain/status/repos/round-verdict.repo';
import { RollupService } from '@backend/domain/status/RollupService';
import { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import {
  statusComponentDays,
  statusComponentMonitors,
  statusComponents,
  statusIncidentComponents,
  statusIncidents,
  statusMaintenanceComponents,
  statusMaintenances,
  statusMonitors,
  statusPages,
  statusRollupsDaily,
  statusRollupsHourly,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { StatusScope } from '@backend/domain/status/scope';
import type { ComponentImpact, MonitorState, RoundVerdict } from '@mocco/common/status';

const D = '2026-09-10';
const NEXT = '2026-09-11';
const H = 3_600_000;
/** `hours` after the start of day D (UTC); past 24 is the next day. */
const at = (hours: number) => new Date(Date.parse(`${D}T00:00:00.000Z`) + hours * H);
/** Long after both days: everything is final. */
const LATER = at(72);

describe('uptime rollups (pglite)', () => {
  let t: TestDb;
  let scope: StatusScope;
  let pageId: string;
  let rollups: RollupService;

  const monitor = async (createdAt = at(-48)) => {
    const row = expectOne(
      await t.db
        .insert(statusMonitors)
        .values({
          ...scope,
          name: 'API',
          kind: MonitorKinds.http,
          spec: monitorSpecSchema.parse({ kind: MonitorKinds.http, url: 'https://api.acme.test/health' }),
          intervalSeconds: 60,
          confirmations: 2,
          recoveryConfirmations: 2,
          quorumMode: QuorumModes.majority,
          state: MonitorStates.up,
          createdAt,
        })
        .returning(),
    );
    return row.id;
  };

  const component = async (name: string, createdAt = at(-48)) =>
    expectOne(
      await t.db
        .insert(statusComponents)
        .values({ ...scope, pageId, name, position: 0, createdAt })
        .returning(),
    ).id;

  const link = async (componentId: string, monitorId: string, impactWhenDown: ComponentImpact) => {
    await t.db
      .insert(statusComponentMonitors)
      .values({ workspaceId: scope.workspaceId, componentId, monitorId, impactWhenDown });
  };

  /** State changes of a monitor: `[from, to, hours]`. */
  const changes = async (monitorId: string, list: readonly [MonitorState, MonitorState, number][]) => {
    const repo = new MonitorStateChangeRepo(t.db);
    await list.reduce(async (previous, [fromState, toState, hours]) => {
      await previous;
      await repo.append({ workspaceId: scope.workspaceId, monitorId, fromState, toState, at: at(hours) });
    }, Promise.resolve());
  };

  /** One verdict a minute from `fromHours`, `p50` ms each. */
  const verdicts = async (monitorId: string, fromHours: number, list: readonly RoundVerdict[], p50 = 100) => {
    const repo = new RoundVerdictRepo(t.db);
    await list.reduce(async (previous, verdict, n) => {
      await previous;
      const roundAt = new Date(at(fromHours).getTime() + n * 60_000);
      await repo.insert({
        workspaceId: scope.workspaceId,
        monitorId,
        roundAt,
        verdict,
        okCount: 1,
        failCount: 0,
        noDataCount: 0,
        p50LatencyMs: verdict === RoundVerdicts.unknown ? null : p50,
        closedAt: roundAt,
      });
    }, Promise.resolve());
  };

  const maintenance = async (componentIds: string[], fromHours: number, toHours: number) => {
    const window = expectOne(
      await t.db
        .insert(statusMaintenances)
        .values({
          ...scope,
          pageId,
          title: 'Upgrade',
          status: MaintenanceStatuses.completed,
          scheduledStart: at(fromHours),
          scheduledEnd: at(toHours),
          actualStart: at(fromHours),
          actualEnd: at(toHours),
        })
        .returning(),
    );
    await t.db
      .insert(statusMaintenanceComponents)
      .values(
        componentIds.map(componentId => ({ workspaceId: scope.workspaceId, maintenanceId: window.id, componentId })),
      );
  };

  const incident = async (
    componentId: string,
    impact: ComponentImpact,
    hours: [number, number],
    visibility: (typeof IncidentVisibilities)[keyof typeof IncidentVisibilities] = IncidentVisibilities.published,
  ) => {
    const row = expectOne(
      await t.db
        .insert(statusIncidents)
        .values({
          ...scope,
          pageId,
          title: 'Errors',
          status: IncidentStatuses.resolved,
          severity: IncidentSeverities.major,
          visibility,
          startedAt: at(hours[0]),
          resolvedAt: at(hours[1]),
        })
        .returning(),
    );
    await t.db
      .insert(statusIncidentComponents)
      .values({ workspaceId: scope.workspaceId, incidentId: row.id, componentId, impact });
    return row.id;
  };

  const daily = async (monitorId: string) =>
    await t.db
      .select()
      .from(statusRollupsDaily)
      .where(eq(statusRollupsDaily.monitorId, monitorId))
      .orderBy(asc(statusRollupsDaily.day));

  const hourly = async (monitorId: string) =>
    await t.db
      .select()
      .from(statusRollupsHourly)
      .where(eq(statusRollupsHourly.monitorId, monitorId))
      .orderBy(asc(statusRollupsHourly.hour));

  const componentDay = async (componentId: string, day = D) => {
    const rows = await t.db.select().from(statusComponentDays).where(eq(statusComponentDays.componentId, componentId));
    return rows.find(row => row.day === day);
  };

  const dirtyAt = async () => expectOne(await t.db.select().from(statusPages)).dirtyAt;
  const clean = async () => {
    await t.db.update(statusPages).set({ dirtyAt: null });
  };

  /** Roll every hour of both days up, then both days. */
  const rollUpAll = async () => {
    await Array.from({ length: 48 }, (_, n) => at(n)).reduce(async (previous, hour) => {
      await previous;
      await rollups.rollupHour(hour);
    }, Promise.resolve());
    await rollups.rollupDay(D, LATER);
    await rollups.rollupDay(NEXT, LATER);
  };

  beforeEach(async () => {
    t = await createTestDb();
    rollups = new RollupService({
      db: t.db,
      snapshots: new SnapshotScheduler({ db: t.db, queue: undefined, now: () => LATER }),
    });
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
    pageId = expectOne(
      await t.db
        .insert(statusPages)
        .values({ ...scope, slug: 'acme', title: 'Acme' })
        .returning(),
    ).id;
    await new RoundVerdictRepo(t.db).partitions.ensure([D, NEXT]);
    await new CheckResultRepo(t.db).partitions.ensure([D, NEXT]);
  });
  afterEach(async () => {
    await t.close();
  });

  it('cuts an outage that spans midnight between the two days, by time, not by rounds', async () => {
    const id = await monitor();
    // Down at 23:30, up at 00:30 the next day; one round in each hour.
    await changes(id, [
      [MonitorStates.up, MonitorStates.down, 23.5],
      [MonitorStates.down, MonitorStates.up, 24.5],
    ]);
    await verdicts(id, 23.5, [RoundVerdicts.fail]);
    await verdicts(id, 24.5, [RoundVerdicts.ok]);
    await rollUpAll();

    const hours = await hourly(id);
    expect(hours.map(row => [row.hour.toISOString(), row.downSeconds])).toEqual([
      [at(23).toISOString(), 1800],
      [at(24).toISOString(), 1800],
    ]);
    const days = await daily(id);
    expect(days.map(row => [row.day, row.downSeconds, row.uptimeRatio])).toEqual([
      [D, 1800, 0.979167],
      [NEXT, 1800, 0.979167],
    ]);
  });

  it('leaves the downtime inside maintenance out of uptime, and maintenance out of the day', async () => {
    const id = await monitor();
    const api = await component('API');
    await link(api, id, ComponentImpacts.partialOutage);
    // Maintenance 10:00 to 12:00; down 11:00 to 13:00, half of it inside the window.
    await maintenance([api], 10, 12);
    await changes(id, [
      [MonitorStates.up, MonitorStates.down, 11],
      [MonitorStates.down, MonitorStates.up, 13],
    ]);
    await rollups.rollupDay(D, LATER);

    const [day] = await daily(id);
    expect(day).toMatchObject({ downSeconds: 7200, maintenanceSeconds: 7200 });
    // 1 - (7200 - 3600) / (86400 - 7200)
    expect(day?.uptimeRatio).toBeCloseTo(0.954545, 6);
    expect(await componentDay(api)).toMatchObject({ worstStatus: ComponentStatuses.partialOutage, downSeconds: 7200 });
  });

  it('never counts unknown rounds as downtime', async () => {
    const id = await monitor();
    // A location outage: half the hour's rounds are unknown, and the state never changes.
    await verdicts(id, 9, [
      ...Array.from({ length: 30 }, () => RoundVerdicts.ok),
      ...Array.from({ length: 30 }, () => RoundVerdicts.unknown),
    ]);
    await rollUpAll();

    expect(await hourly(id)).toEqual([
      expect.objectContaining({
        rounds: 60,
        okRounds: 30,
        failRounds: 0,
        unknownRounds: 30,
        downSeconds: 0,
        latencyCount: 30,
      }),
    ]);
    const [day] = await daily(id);
    expect(day).toMatchObject({ rounds: 60, okRounds: 30, downSeconds: 0, uptimeRatio: 1 });
  });

  it('measures a monitor created mid-day from its creation, and has no row before it', async () => {
    const id = await monitor(at(12));
    await changes(id, [
      [MonitorStates.pending, MonitorStates.up, 12],
      [MonitorStates.up, MonitorStates.down, 18],
      [MonitorStates.down, MonitorStates.up, 19],
    ]);
    await rollups.rollupDay('2026-09-09', LATER);
    await rollups.rollupDay(D, LATER);

    // One hour down out of twelve observed.
    const days = await daily(id);
    expect(days.map(row => [row.day, row.downSeconds, row.uptimeRatio])).toEqual([[D, 3600, 0.916667]]);
  });

  it('counts the current day only up to now', async () => {
    const id = await monitor();
    await changes(id, [[MonitorStates.up, MonitorStates.down, 5]]);
    await rollups.rollupDay(D, at(6));
    // Down one hour of the six so far.
    const [day] = await daily(id);
    expect(day).toMatchObject({ downSeconds: 3600, uptimeRatio: 0.833333 });
  });

  it('gives identical rows when the same hour and day are rolled up twice', async () => {
    const id = await monitor();
    const api = await component('API');
    await link(api, id, ComponentImpacts.majorOutage);
    await changes(id, [
      [MonitorStates.up, MonitorStates.down, 9.25],
      [MonitorStates.down, MonitorStates.up, 9.75],
    ]);
    await verdicts(id, 9, [RoundVerdicts.ok, RoundVerdicts.degraded, RoundVerdicts.fail, RoundVerdicts.unknown], 250);

    await rollups.rollupHour(at(9));
    const first = await hourly(id);
    await rollups.rollupHour(at(9));
    expect(await hourly(id)).toEqual(first);
    expect(first).toEqual([
      expect.objectContaining({
        rounds: 4,
        okRounds: 2,
        failRounds: 1,
        unknownRounds: 1,
        downSeconds: 1800,
        latencySumMs: 750,
      }),
    ]);

    await rollups.rollupDay(D, LATER);
    const day = await daily(id);
    const bar = await componentDay(api);
    await rollups.rollupDay(D, LATER);
    expect(await daily(id)).toEqual(day);
    expect(await componentDay(api)).toEqual(bar);
    expect(day[0]).toMatchObject({ rounds: 4, okRounds: 2, p95Ms: expect.any(Number) });
  });

  it('keeps daily rollups unchanged when the raw and verdict partitions of the day are dropped', async () => {
    const id = await monitor();
    const api = await component('API');
    await link(api, id, ComponentImpacts.partialOutage);
    await changes(id, [
      [MonitorStates.up, MonitorStates.down, 14],
      [MonitorStates.down, MonitorStates.up, 14.5],
    ]);
    await verdicts(
      id,
      14,
      Array.from({ length: 60 }, (_, n) => (n < 30 ? RoundVerdicts.fail : RoundVerdicts.ok)),
    );
    await rollUpAll();
    const before = { daily: await daily(id), bar: await componentDay(api) };

    await new CheckResultRepo(t.db).partitions.drop(D);
    await new RoundVerdictRepo(t.db).partitions.drop(D);
    expect(await new RoundVerdictRepo(t.db).partitions.days()).toEqual([NEXT]);
    await rollups.rollupDay(D, LATER);

    expect(await daily(id)).toEqual(before.daily);
    expect(await componentDay(api)).toEqual(before.bar);
    expect(before.daily[0]).toMatchObject({ rounds: 60, okRounds: 30, downSeconds: 1800 });
  });

  it("gives a component's day the worst status of its monitors, published incidents and maintenance", async () => {
    const id = await monitor();
    const api = await component('API');
    const web = await component('Dashboard');
    const docs = await component('Docs');
    const quiet = await component('Status');
    await link(api, id, ComponentImpacts.degraded);
    await link(web, id, ComponentImpacts.partialOutage);
    await changes(id, [
      [MonitorStates.up, MonitorStates.down, 3],
      [MonitorStates.down, MonitorStates.up, 4],
    ]);
    // A published major outage on the API outranks what the monitor puts on it; a draft never counts.
    const major = await incident(api, ComponentImpacts.majorOutage, [6, 7]);
    await incident(web, ComponentImpacts.majorOutage, [6, 7], IncidentVisibilities.draft);
    await maintenance([docs], 20, 21);
    await rollups.rollupDay(D, LATER);

    expect(await componentDay(api)).toMatchObject({
      worstStatus: ComponentStatuses.majorOutage,
      downSeconds: 3600,
      incidentIds: [major],
      uptimeRatio: 0.958333,
    });
    expect(await componentDay(web)).toMatchObject({ worstStatus: ComponentStatuses.partialOutage, incidentIds: [] });
    // No monitor reports on it: no measured uptime, and maintenance as the worst it showed.
    expect(await componentDay(docs)).toMatchObject({ worstStatus: ComponentStatuses.maintenance, uptimeRatio: null });
    expect(await componentDay(quiet)).toMatchObject({ worstStatus: ComponentStatuses.operational, downSeconds: 0 });
  });

  it('starts a component day only once the component exists', async () => {
    const api = await component('API', at(30));
    await rollups.rollupDay(D, LATER);
    await rollups.rollupDay(NEXT, LATER);
    expect(await componentDay(api, D)).toBeUndefined();
    expect(await componentDay(api, NEXT)).toMatchObject({ worstStatus: ComponentStatuses.operational });
  });

  it('runs the hours that ended ten minutes ago, then today and, early on, yesterday', async () => {
    const id = await monitor();
    await verdicts(id, 22, [RoundVerdicts.ok]);
    await verdicts(id, 23.9, [RoundVerdicts.ok]);

    // 00:05: hour 23 hasn't settled, and the day is still D.
    expect(await rollups.run(at(24 + 5 / 60))).toMatchObject({ hours: [at(20), at(21), at(22)], days: [D] });
    // 00:15: hour 23 rolls up, D is final, and the new day starts.
    expect(await rollups.run(at(24.25))).toMatchObject({ hours: [at(23)], days: [D, NEXT] });
    const hours = await hourly(id);
    expect(hours.map(row => row.hour)).toEqual([at(22), at(23)]);
    const days = await daily(id);
    expect(days.map(row => [row.day, row.rounds])).toEqual([
      [D, 2],
      [NEXT, 0],
    ]);
    // 03:00: yesterday is no longer rechecked.
    expect(await rollups.run(at(27))).toMatchObject({ days: [NEXT] });
  });

  it('marks the page dirty when a rollup changes a bar, and only then', async () => {
    const id = await monitor();
    const api = await component('API');
    await link(api, id, ComponentImpacts.partialOutage);

    // A new day's bar is a change.
    await rollups.rollupDay(D, LATER);
    expect(await dirtyAt()).toEqual(LATER);
    await clean();

    // The same day again: nothing the page shows moved.
    await rollups.rollupDay(D, LATER);
    expect(await dirtyAt()).toBeNull();

    // An outage changes the day's status and uptime.
    await changes(id, [
      [MonitorStates.up, MonitorStates.down, 8],
      [MonitorStates.down, MonitorStates.up, 9],
    ]);
    await rollups.rollupDay(D, LATER);
    expect(await dirtyAt()).toEqual(LATER);
    expect(await componentDay(api)).toMatchObject({
      worstStatus: ComponentStatuses.partialOutage,
      uptimeRatio: 0.958333,
    });
  });

  it("reads a monitor's p50 and p95 latency from the rollups' histograms", async () => {
    const id = await monitor();
    // Hour 9: 45 rounds at 50 ms, then 15 at 900 ms; hour 10: 60 rounds at 200 ms.
    await verdicts(
      id,
      9,
      Array.from({ length: 45 }, () => RoundVerdicts.ok),
      50,
    );
    await verdicts(
      id,
      9.75,
      Array.from({ length: 15 }, () => RoundVerdicts.ok),
      900,
    );
    await verdicts(
      id,
      10,
      Array.from({ length: 60 }, () => RoundVerdicts.ok),
      200,
    );
    await rollUpAll();
    const status = createStatusDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      now: () => at(30),
    });

    const { history } = await status.statusMonitors.get(scope, id);
    const [nine, ten] = history.hours;
    // 50 ms is in the 32–64 bucket and 900 ms in 512–1024: p50 among the fast, p95 among the slow.
    expect(nine).toMatchObject({ hour: at(9), rounds: 60 });
    expect(nine?.p50Ms).toBeGreaterThanOrEqual(32);
    expect(nine?.p50Ms).toBeLessThan(64);
    expect(nine?.p95Ms).toBeGreaterThanOrEqual(512);
    expect(nine?.p95Ms).toBeLessThan(1024);
    expect(ten).toMatchObject({ hour: at(10) });
    expect(ten?.p95Ms).toBeGreaterThanOrEqual(128);
    expect(ten?.p95Ms).toBeLessThan(256);
    // The day merges the hours' histograms: 120 rounds, p50 in the 200 ms bucket, p95 among the slow.
    const [day] = history.days;
    expect(day).toMatchObject({ day: D, rounds: 120, uptimeRatio: 1 });
    expect(day?.p50Ms).toBeGreaterThanOrEqual(128);
    expect(day?.p50Ms).toBeLessThan(256);
    expect(day?.p95Ms).toBeGreaterThanOrEqual(512);
  });

  it('deletes hourly rollups past 90 days and keeps raw results for STATUS_RAW_RETENTION_DAYS', async () => {
    const id = await monitor(at(-24 * 100));
    await verdicts(id, 9, [RoundVerdicts.ok]);
    await rollups.rollupHour(at(9));
    const retention = new TimeSeriesRetention({ db: t.db, checkResultDays: 3 });

    const soon = await retention.run(at(24 * 89));
    expect(soon.hourlyRollupsDeleted).toBe(0);
    expect(soon.checkResults.dropped).toEqual([D, NEXT]);
    const later = await retention.run(at(24 * 91));
    expect(later.hourlyRollupsDeleted).toBe(1);
    expect(await hourly(id)).toEqual([]);
  });
});
