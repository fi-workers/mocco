// Location health (#151): a probe that stops polling is marked silent once, its private
// location alerts its workspace (a shared one logs for Mocco's operator), rounds stop waiting
// for it, and it is cleared with one more alert when it polls again.
import { randomUUID } from 'node:crypto';

import { StatusEventTypes } from '@mocco/common/events';
import { CheckOutcomes, LocationKinds, MonitorKinds, monitorInputSchema, ProbeProtocol } from '@mocco/common/status';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createTestEventBus } from '@backend/domain/events/testing/event-bus';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { LocationHealthService } from '@backend/domain/status/LocationHealthService';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import {
  domainEvents,
  statusLocations,
  statusMonitors,
  statusRoundVerdicts,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { ProbeLocation } from '@backend/domain/status/ProbeService';
import type { StatusScope } from '@backend/domain/status/scope';

const T0 = new Date('2026-10-06T09:00:00.000Z');
const seconds = (n: number) => new Date(T0.getTime() + n * 1000);
const SILENT = ProbeProtocol.silentAfterSeconds;

describe('location health (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let health: LocationHealthService;
  let scope: StatusScope;
  let actor: string;
  let clock: Date;
  let logged: { message: string; details: Record<string, unknown> }[];

  const authenticated = async (token: string): Promise<ProbeLocation> => {
    const location = await status.statusProbes.authenticate(token);
    if (location === undefined) {
      throw new Error('fixture location did not authenticate');
    }
    return location;
  };

  const hosted = async (code: string) => {
    const token = generateLocationToken();
    await new LocationRepo(t.db).insert({
      workspaceId: null,
      code,
      name: code,
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(token),
    });
    return await authenticated(token);
  };

  const privateLocation = async (code: string) => {
    const { token } = await status.statusLocations.create(scope.workspaceId, actor, { code, name: `Office ${code}` });
    return await authenticated(token);
  };

  const seen = async (...locations: ProbeLocation[]) => {
    await Promise.all(
      locations.map(async location => await status.statusProbes.heartbeat(location, { agentVersion: '1' })),
    );
  };

  const alerts = async () => {
    const rows = await t.db.select().from(domainEvents).orderBy(domainEvents.occurredAt);
    return rows.map(event => ({
      type: event.type,
      title: (event.payload as { message: { title: string } }).message.title,
    }));
  };

  const silentCodes = async () => {
    const rows = await t.db.select().from(statusLocations).orderBy(statusLocations.code);
    return rows.filter(row => row.unhealthySince !== null).map(row => row.code);
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    logged = [];
    const events = createTestEventBus(t.db, () => clock);
    status = createStatusDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      events,
      now: () => clock,
    });
    health = new LocationHealthService({
      db: t.db,
      events,
      log: (message, details) => {
        logged.push({ message, details });
      },
    });
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
    await new TimeSeriesRetention({ db: t.db }).run(T0);
  });
  afterEach(async () => {
    await t.close();
  });

  it('marks a silent location once, stops waiting for it, and clears it when it polls again', async () => {
    const fra = await hosted('fra');
    const sin = await hosted('sin');
    const office = await privateLocation('office');
    // Seen, but no monitor runs there: going quiet is no one's problem.
    const lab = await privateLocation('lab');
    // Never seen: it hasn't started, so it isn't silent either.
    await privateLocation('spare');
    await seen(fra, sin, office, lab);

    clock = seconds(SILENT + 20);
    await seen(fra);
    const created = await status.statusMonitors.create(
      scope,
      actor,
      monitorInputSchema.parse({
        name: 'API',
        spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health' },
        locationIds: [fra.id, sin.id, office.id],
      }),
    );
    expect(await health.sweep(clock)).toEqual({ silent: 2, back: 0 });
    expect(await silentCodes()).toEqual(['office', 'sin']);
    expect(await alerts()).toEqual([
      { type: StatusEventTypes.statusLocationUnhealthy, title: 'Location silent: Office office' },
    ]);
    // The shared location is Mocco's own: a log line for the operator, never a customer's event.
    expect(logged).toEqual([
      { message: '[status] shared location silent', details: expect.objectContaining({ code: 'sin', kind: 'hosted' }) },
    ]);

    // fra's report closes the round at once: the silent locations aren't waited for, and are no_data.
    clock = seconds(SILENT + 25);
    const { leases } = await status.statusProbes.lease(fra, { agentVersion: '1', capacity: 10 });
    await status.statusProbes.report(
      fra,
      leases.map(lease => ({ ...lease, outcome: CheckOutcomes.ok, latencyMs: 80 })),
    );
    expect(expectOne(await t.db.select().from(statusRoundVerdicts))).toMatchObject({
      monitorId: created.id,
      verdict: 'ok',
      okCount: 1,
      noDataCount: 2,
    });
    expect(expectOne(await t.db.select().from(statusMonitors))).toMatchObject({ state: 'up' });

    // Once: the next sweeps find nothing new.
    clock = seconds(SILENT + 80);
    expect(await health.sweep(clock)).toEqual({ silent: 0, back: 0 });
    expect(await alerts()).toHaveLength(1);

    // office polls again: cleared at the next sweep, with one recovery alert.
    clock = seconds(SILENT + 90);
    await seen(office);
    expect(await health.sweep(clock)).toEqual({ silent: 0, back: 1 });
    expect(await silentCodes()).toEqual(['sin']);
    expect(await alerts()).toEqual([
      { type: StatusEventTypes.statusLocationUnhealthy, title: 'Location silent: Office office' },
      { type: StatusEventTypes.statusLocationRecovered, title: 'Location back: Office office' },
    ]);
    expect(await health.sweep(clock)).toEqual({ silent: 0, back: 0 });
  });

  it('does not mark a location whose only monitors are paused, nor a disabled one', async () => {
    const office = await privateLocation('office');
    const closed = await privateLocation('closed');
    await seen(office, closed);
    const created = await status.statusMonitors.create(
      scope,
      actor,
      monitorInputSchema.parse({
        name: 'API',
        spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health' },
        locationIds: [office.id, closed.id],
      }),
    );
    await status.statusLocations.disable(scope.workspaceId, actor, closed.id);
    await status.statusMonitors.pause(scope, actor, created.id);

    clock = seconds(SILENT + 1);
    expect(await health.sweep(clock)).toEqual({ silent: 0, back: 0 });

    await status.statusMonitors.resume(scope, actor, created.id);
    expect(await health.sweep(clock)).toEqual({ silent: 1, back: 0 });
    expect(await silentCodes()).toEqual(['office']);
  });
});
