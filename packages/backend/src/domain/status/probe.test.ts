import { randomUUID } from 'node:crypto';

import { CheckOutcomes, LocationKinds, MonitorKinds, monitorInputSchema } from '@mocco/common/status';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { ProbeService } from '@backend/domain/status/ProbeService';
import { CheckResultRepo } from '@backend/domain/status/repos/check-result.repo';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import { statusCheckResults, statusLocations, statusProbeLeases, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { ProbeLease, ProbeLocation } from '@backend/domain/status/ProbeService';
import type { StatusScope } from '@backend/domain/status/scope';
import type { ProbeResult } from '@mocco/common/status';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const seconds = (n: number) => new Date(T0.getTime() + n * 1000);

/** A passing result for a lease, as a probe reports it. */
const okFor = (lease: ProbeLease): ProbeResult => ({
  leaseId: lease.leaseId,
  monitorId: lease.monitorId,
  roundAt: lease.roundAt,
  outcome: CheckOutcomes.ok,
  statusCode: 200,
  latencyMs: 120,
});

describe('probe protocol (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let probes: ProbeService;
  let scope: StatusScope;
  let otherScope: StatusScope;
  let actor: string;
  let clock: Date;

  const newScope = async (handle: string): Promise<StatusScope> => {
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: handle, slug: randomUUID() }).returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: handle, handle });
    return { workspaceId, projectId: project.id };
  };

  /** A hosted location and the probe location its token authenticates. */
  const hosted = async (code: string): Promise<{ location: ProbeLocation; token: string }> => {
    const token = generateLocationToken();
    await new LocationRepo(t.db).insert({
      workspaceId: null,
      code,
      name: code,
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(token),
    });
    const location = await probes.authenticate(token);
    if (location === undefined) {
      throw new Error('fixture location did not authenticate');
    }
    return { location, token };
  };

  const monitor = async (on: StatusScope, locationIds: string[], name = 'API') =>
    await status.statusMonitors.create(
      on,
      actor,
      monitorInputSchema.parse({
        name,
        spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health' },
        locationIds,
      }),
    );

  /** The monitors of the rounds one lease call takes. */
  const leasedMonitors = async (location: ProbeLocation) => {
    const { leases } = await probes.lease(location, { agentVersion: '1', capacity: 50 });
    return leases.map(lease => lease.monitorId);
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    status = createStatusDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), now: () => clock });
    probes = new ProbeService({ db: t.db, now: () => clock });
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    scope = await newScope('acme');
    otherScope = await newScope('other');
    await new TimeSeriesRetention({ db: t.db }).run(T0);
  });
  afterEach(async () => {
    await t.close();
  });

  it('authenticates only an enabled location by its token', async () => {
    const { location: office, token } = await status.statusLocations.create(scope.workspaceId, actor, {
      code: 'office',
      name: 'Office',
    });

    await expect(probes.authenticate(token)).resolves.toMatchObject({ id: office.id, workspaceId: scope.workspaceId });
    await expect(probes.authenticate(generateLocationToken())).resolves.toBeUndefined();
    await status.statusLocations.disable(scope.workspaceId, actor, office.id);
    await expect(probes.authenticate(token)).resolves.toBeUndefined();
  });

  it('leases each due round once per location, and never to two concurrent callers', async () => {
    const fra = await hosted('fra');
    const iad = await hosted('iad');
    const monitors = await Promise.all(
      Array.from(
        { length: 6 },
        async (_, index) => await monitor(scope, [fra.location.id, iad.location.id], `m${index}`),
      ),
    );

    const [first, second] = await Promise.all([
      probes.lease(fra.location, { agentVersion: '1.0.0', capacity: 4 }),
      probes.lease(fra.location, { agentVersion: '1.0.0', capacity: 4 }),
    ]);
    const again = await probes.lease(fra.location, { agentVersion: '1.0.0', capacity: 10 });
    const atIad = await probes.lease(iad.location, { agentVersion: '1.0.0', capacity: 10 });

    const fraMonitors = [...first.leases, ...second.leases].map(lease => lease.monitorId);
    expect(fraMonitors).toHaveLength(6);
    expect(new Set(fraMonitors)).toEqual(new Set(monitors.map(row => row.id)));
    expect(again.leases).toEqual([]);
    // Another location gets its own lease of every round: regions never compete.
    expect(atIad.leases).toHaveLength(6);
    expect(first.leases[0]).toMatchObject({ roundAt: T0, expiresAt: seconds(10 + 15), spec: { timeoutMs: 10_000 } });
    expect(await t.db.select().from(statusProbeLeases)).toHaveLength(12);
  });

  it('leases only rounds within the lookahead, skips paused monitors, and keeps a private location to its workspace', async () => {
    const { location: office, token } = await status.statusLocations.create(scope.workspaceId, actor, {
      code: 'office',
      name: 'Office',
    });
    const officeProbe = await probes.authenticate(token);
    const fra = await hosted('fra');
    const paused = await monitor(scope, [fra.location.id], 'paused');
    await status.statusMonitors.pause(scope, actor, paused.id);
    const theirs = await monitor(otherScope, [fra.location.id], 'theirs');
    const ours = await monitor(scope, [office.id], 'ours');
    // A row no service would write: another workspace's monitor assigned to this private location.
    await t.db.execute(
      `INSERT INTO mocco_status_monitor_locations (monitor_id, location_id, workspace_id) VALUES ('${theirs.id}', '${office.id}', '${otherScope.workspaceId}')`,
    );

    if (officeProbe === undefined) {
      throw new Error('fixture location did not authenticate');
    }

    expect(await leasedMonitors(officeProbe)).toEqual([ours.id]);
    expect(await leasedMonitors(fra.location)).toEqual([theirs.id]);

    clock = seconds(-120);
    const later = await monitor(scope, [fra.location.id], 'later');
    clock = seconds(-200);
    // From T0-200s, a round due at T0-120s is beyond the 60 s lookahead; from T0 it is overdue.
    expect(await leasedMonitors(fra.location)).toEqual([]);
    clock = T0;
    expect(await leasedMonitors(fra.location)).toEqual([later.id]);
  });

  it('stores matching results once and refuses forged, mismatched and late ones', async () => {
    const fra = await hosted('fra');
    const iad = await hosted('iad');
    const first = await monitor(scope, [fra.location.id, iad.location.id], 'first');
    const second = await monitor(scope, [fra.location.id], 'second');
    const { leases: fraLeases } = await probes.lease(fra.location, { agentVersion: '1', capacity: 50 });
    const { leases: iadLeases } = await probes.lease(iad.location, { agentVersion: '1', capacity: 50 });
    const fraFirst = fraLeases.find(lease => lease.monitorId === first.id);
    const fraSecond = fraLeases.find(lease => lease.monitorId === second.id);
    const [iadFirst] = iadLeases;
    if (fraFirst === undefined || fraSecond === undefined || iadFirst === undefined) {
      throw new Error('fixture leases missing');
    }

    clock = seconds(5);
    // iad's token reporting fra's lease, and fra claiming its lease was for another monitor.
    const forged = await probes.report(iad.location, [okFor(fraFirst)]);
    const mismatched = await probes.report(fra.location, [{ ...okFor(fraFirst), monitorId: second.id }]);
    const shifted = await probes.report(fra.location, [{ ...okFor(fraFirst), roundAt: seconds(60) }]);
    const accepted = await probes.report(fra.location, [okFor(fraFirst), okFor(fraFirst)]);
    const retried = await probes.report(fra.location, [okFor(fraFirst)]);
    const ownFailure = await probes.report(iad.location, [{ ...okFor(iadFirst), outcome: CheckOutcomes.fail }]);
    // Past the round plus the 10 s timeout plus the 15 s grace.
    clock = seconds(26);
    const late = await probes.report(fra.location, [okFor(fraSecond)]);

    expect(forged).toEqual({ accepted: 0, duplicates: 0, rejected: [fraFirst.leaseId] });
    expect(mismatched.rejected).toEqual([fraFirst.leaseId]);
    expect(shifted.rejected).toEqual([fraFirst.leaseId]);
    expect(accepted).toEqual({ accepted: 1, duplicates: 1, rejected: [] });
    expect(retried).toEqual({ accepted: 0, duplicates: 1, rejected: [] });
    expect(ownFailure).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    expect(late.rejected).toEqual([fraSecond.leaseId]);
    const stored = await t.db.select().from(statusCheckResults);
    expect(new Set(stored.map(row => `${row.monitorId}:${row.locationId}:${row.outcome}`))).toEqual(
      new Set([`${first.id}:${fra.location.id}:ok`, `${first.id}:${iad.location.id}:fail`]),
    );
    const reported = await t.db.select().from(statusProbeLeases);
    expect(new Set(reported.filter(lease => lease.reportedAt !== null).map(lease => lease.id))).toEqual(
      new Set([fraFirst.leaseId, iadFirst.leaseId]),
    );
  });

  it('records heartbeats and lease calls as the location being seen', async () => {
    const fra = await hosted('fra');
    clock = seconds(30);
    await probes.heartbeat(fra.location, { agentVersion: '1.2.3' });

    const [row] = await t.db.select().from(statusLocations);
    expect(row).toMatchObject({ lastSeenAt: seconds(30), agentVersion: '1.2.3' });
  });

  it('creates day partitions ahead, drops those past retention, and creates a missing one on ingest', async () => {
    const results = new CheckResultRepo(t.db);
    const retention = new TimeSeriesRetention({ db: t.db });
    expect(await results.partitions.days()).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);

    const later = await retention.run(new Date('2026-10-20T00:30:00.000Z'));

    expect(later.checkResults.dropped).toEqual(['2026-10-05', '2026-10-06']);
    // Verdicts are kept 30 days, so none of theirs is old enough yet.
    expect(later.roundVerdicts.dropped).toEqual([]);
    expect(later.roundVerdicts.created).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    expect(await results.partitions.days()).toEqual(['2026-10-07', '2026-10-20', '2026-10-21', '2026-10-22']);

    const fra = await hosted('fra');
    clock = new Date('2026-11-30T12:00:00.000Z');
    await monitor(scope, [fra.location.id]);
    const { leases } = await probes.lease(fra.location, { agentVersion: '1', capacity: 1 });
    const [lease] = leases;
    if (lease === undefined) {
      throw new Error('fixture lease missing');
    }
    await expect(probes.report(fra.location, [okFor(lease)])).resolves.toMatchObject({ accepted: 1 });
    expect(await results.partitions.days()).toContain('2026-11-30');
  });
});
