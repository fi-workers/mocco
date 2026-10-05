// Heartbeat monitors (#153) on pglite: the token is returned once and stored hashed, silence past
// the period and grace takes the monitor down, the next success ping recovers it, a failure ping
// or a non-zero exit code takes it down at once, pauses record pings without moving the state,
// heartbeats are never leased or watched, and their downtime reaches the rollups.
import { randomUUID } from 'node:crypto';

import {
  ComponentImpacts,
  IncidentOrigins,
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
import { DeployWatchService } from '@backend/domain/status/DeployWatchService';
import { MonitorKindError } from '@backend/domain/status/errors';
import { heartbeatAlertDescription } from '@backend/domain/status/heartbeat';
import { hashHeartbeatToken } from '@backend/domain/status/heartbeat-token';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import {
  statusIncidentMonitors,
  statusIncidents,
  statusMonitorLocations,
  statusMonitorStateChanges,
  statusMonitors,
  statusRollupsDaily,
  statusRoundVerdicts,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The heartbeats below: a 10-minute period and a 5-minute grace. */
const PERIOD_S = 600;
const GRACE_S = 300;
const WINDOW_MS = (PERIOD_S + GRACE_S) * SECOND;

describe('heartbeat alerts', () => {
  it('say why the heartbeat went down', () => {
    const timing = { heartbeatPeriodSeconds: PERIOD_S, heartbeatGraceSeconds: GRACE_S };
    expect(heartbeatAlertDescription(timing, { by: 'evaluator', cause: 'silence', verdict: 'fail' })).toBe(
      'No ping for 15 min (the period and the grace).',
    );
    expect(heartbeatAlertDescription(timing, { by: 'heartbeat', cause: 'fail', exitCode: 2 })).toBe(
      'The job exited with code 2.',
    );
    expect(heartbeatAlertDescription(timing, { by: 'heartbeat', cause: 'fail' })).toBe('The job reported a failure.');
    expect(heartbeatAlertDescription(timing, { by: 'evaluator', okCount: 1, failCount: 0 })).toBeUndefined();
  });
});

describe('heartbeat monitors (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let scope: StatusScope;
  let actor: string;
  let clock: Date;

  const at = (ms: number) => new Date(T0.getTime() + ms);
  const current = async (monitorId: string) =>
    expectOne(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, monitorId)));
  const changes = async (monitorId: string) =>
    await t.db
      .select()
      .from(statusMonitorStateChanges)
      .where(eq(statusMonitorStateChanges.monitorId, monitorId))
      .orderBy(statusMonitorStateChanges.at);
  const evaluateAt = async (ms: number) => {
    clock = at(ms);
    return await status.statusVerdicts.evaluate({ now: clock });
  };
  const pingAt = async (ms: number, token: string, ping: Parameters<StatusDomain['statusHeartbeats']['ping']>[1]) => {
    clock = at(ms);
    return await status.statusHeartbeats.ping(token, ping);
  };

  const newHeartbeat = async (extra: Record<string, unknown> = {}) => {
    const page = await status.statusPages.createPage(scope, actor, { slug: randomUUID().slice(0, 8), title: 'Jobs' });
    const nightly = await status.statusPages.createComponent(scope, page.id, { name: 'Nightly export' });
    return await status.statusMonitors.create(
      scope,
      actor,
      monitorInputSchema.parse({
        name: 'Nightly export',
        spec: { kind: MonitorKinds.heartbeat, periodSeconds: PERIOD_S, graceSeconds: GRACE_S },
        components: [{ componentId: nightly.id, impactWhenDown: ComponentImpacts.partialOutage }],
        ...extra,
      }),
    );
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    status = createStatusDomain(t.db, { audit, now: () => clock });
    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    scope = { workspaceId, projectId: project.id };
    await new TimeSeriesRetention({ db: t.db }).run(T0);
  });
  afterEach(async () => {
    await t.close();
  });

  it('returns the token once, stores only its SHA-256, and keeps no locations', async () => {
    const created = await newHeartbeat();
    expect(created.heartbeatToken).toMatch(/^mhb_[\w-]{43}$/u);
    expect(created).not.toHaveProperty('heartbeatTokenHash');

    const row = await current(created.id);
    expect(row.heartbeatTokenHash).toBe(hashHeartbeatToken(created.heartbeatToken ?? ''));
    expect(JSON.stringify(row)).not.toContain(created.heartbeatToken);
    expect(row).toMatchObject({
      kind: MonitorKinds.heartbeat,
      spec: { kind: MonitorKinds.heartbeat },
      state: MonitorStates.pending,
      heartbeatPeriodSeconds: PERIOD_S,
      heartbeatGraceSeconds: GRACE_S,
      confirmations: 1,
      recoveryConfirmations: 1,
      nextRoundAt: at(WINDOW_MS),
    });
    expect(await t.db.select().from(statusMonitorLocations)).toEqual([]);

    // Reads never carry the hash either.
    const [listed] = await status.statusMonitors.list(scope);
    const read = await status.statusMonitors.get(scope, created.id);
    expect(listed).not.toHaveProperty('heartbeatTokenHash');
    expect(read.monitor).not.toHaveProperty('heartbeatTokenHash');
  });

  it('refuses locations on a heartbeat and a probe monitor without any', () => {
    const heartbeat = monitorInputSchema.safeParse({
      name: 'Job',
      spec: { kind: MonitorKinds.heartbeat },
      locationIds: [randomUUID()],
    });
    const http = monitorInputSchema.safeParse({
      name: 'API',
      spec: { kind: MonitorKinds.http, url: 'https://api.acme.test' },
    });
    expect([heartbeat.success, http.success]).toEqual([false, false]);
  });

  it('enforces the heartbeat columns in the DB', async () => {
    const base = {
      ...scope,
      name: 'x',
      intervalSeconds: 600,
      confirmations: 1,
      recoveryConfirmations: 1,
      quorumMode: 'any' as const,
    };
    const insert = async (values: Partial<typeof statusMonitors.$inferInsert>) =>
      await t.db
        .insert(statusMonitors)
        .values({ ...base, kind: MonitorKinds.heartbeat, spec: { kind: MonitorKinds.heartbeat }, ...values });
    // A heartbeat without its token or period, or with two confirmations.
    await expect(insert({ heartbeatPeriodSeconds: 600, heartbeatGraceSeconds: 60 })).rejects.toThrow();
    await expect(insert({ heartbeatTokenHash: 'a', heartbeatGraceSeconds: 60 })).rejects.toThrow();
    await expect(
      insert({ heartbeatTokenHash: 'b', heartbeatPeriodSeconds: 600, heartbeatGraceSeconds: 60, confirmations: 2 }),
    ).rejects.toThrow();
    // A probe monitor with a token.
    await expect(
      insert({
        kind: MonitorKinds.http,
        spec: { kind: MonitorKinds.http, url: 'https://x.test' } as never,
        heartbeatTokenHash: 'c',
      }),
    ).rejects.toThrow();
    await expect(
      insert({ heartbeatTokenHash: 'd', heartbeatPeriodSeconds: 600, heartbeatGraceSeconds: 60 }),
    ).resolves.toBeDefined();
  });

  it('goes down once the period and grace pass in silence, and recovers on the next ping', async () => {
    const { id, heartbeatToken } = await newHeartbeat({ incidentPolicy: 'publish' });
    const token = heartbeatToken ?? '';

    expect(await pingAt(MINUTE, token, { signal: 'success' })).toBe(true);
    expect(await current(id)).toMatchObject({
      state: MonitorStates.up,
      lastPingAt: at(MINUTE),
      nextRoundAt: at(MINUTE + WINDOW_MS),
    });

    // Not yet: a second before the deadline.
    await evaluateAt(MINUTE + WINDOW_MS - SECOND);
    expect(await current(id)).toMatchObject({ state: MonitorStates.up });

    await evaluateAt(MINUTE + WINDOW_MS + SECOND);
    const down = await current(id);
    expect(down.state).toBe(MonitorStates.down);
    // Probed nothing: no verdict rows.
    expect(await t.db.select().from(statusRoundVerdicts)).toEqual([]);
    // The usual reaction: an incident opened by the monitor.
    const [incident] = await t.db.select().from(statusIncidents);
    expect(incident).toMatchObject({ title: 'Nightly export is down', origin: IncidentOrigins.monitor });

    // Still silent a period later: still down, no second change.
    await evaluateAt(MINUTE + 2 * WINDOW_MS + 2 * SECOND);
    expect(await current(id)).toMatchObject({ state: MonitorStates.down });

    expect(await pingAt(MINUTE + 2 * WINDOW_MS + 3 * SECOND, token, { signal: 'success' })).toBe(true);
    expect(await current(id)).toMatchObject({ state: MonitorStates.up });
    const history = await changes(id);
    expect(history.map(change => [change.fromState, change.toState, change.reason])).toEqual([
      [MonitorStates.pending, MonitorStates.up, { by: 'heartbeat', cause: 'success', verdict: 'ok' }],
      [
        MonitorStates.up,
        MonitorStates.down,
        { by: 'evaluator', cause: 'silence', verdict: 'fail', lastPingAt: at(MINUTE).toISOString() },
      ],
      [MonitorStates.down, MonitorStates.up, { by: 'heartbeat', cause: 'success', verdict: 'ok' }],
    ]);
    const [link] = await t.db.select().from(statusIncidentMonitors);
    expect(link?.closedAt).not.toBeNull();
  });

  it('goes down when it was never pinged within the period and grace of its creation', async () => {
    const { id } = await newHeartbeat();
    await evaluateAt(WINDOW_MS - SECOND);
    expect(await current(id)).toMatchObject({ state: MonitorStates.pending });
    await evaluateAt(WINDOW_MS + SECOND);
    expect(await current(id)).toMatchObject({ state: MonitorStates.down });
  });

  it('goes down at once on /fail and on a non-zero exit code; exit code 0 recovers', async () => {
    const { id, heartbeatToken } = await newHeartbeat();
    const token = heartbeatToken ?? '';

    await pingAt(MINUTE, token, { signal: 'success' });
    await pingAt(2 * MINUTE, token, { signal: 'fail' });
    expect(await current(id)).toMatchObject({ state: MonitorStates.down });

    await pingAt(3 * MINUTE, token, { signal: 'success', exitCode: 0 });
    expect(await current(id)).toMatchObject({ state: MonitorStates.up });

    await pingAt(4 * MINUTE, token, { signal: 'fail', exitCode: 3 });
    expect(await current(id)).toMatchObject({ state: MonitorStates.down });
    const history = await changes(id);
    expect(history.at(-1)?.reason).toEqual({
      by: 'heartbeat',
      cause: 'fail',
      exitCode: 3,
      verdict: 'fail',
    });
  });

  it('records the run duration from /start to the completion after it', async () => {
    const { id, heartbeatToken } = await newHeartbeat();
    const token = heartbeatToken ?? '';

    await pingAt(MINUTE, token, { signal: 'start' });
    // A start alone moves neither the state nor the deadline.
    expect(await current(id)).toMatchObject({
      state: MonitorStates.pending,
      lastStartAt: at(MINUTE),
      lastPingAt: null,
      nextRoundAt: at(WINDOW_MS),
    });
    await pingAt(MINUTE + 42 * SECOND, token, { signal: 'success' });
    expect(await current(id)).toMatchObject({ lastDurationMs: 42 * SECOND, lastPingAt: at(MINUTE + 42 * SECOND) });

    // A completion without a new start has no duration.
    await pingAt(5 * MINUTE, token, { signal: 'success' });
    expect(await current(id)).toMatchObject({ lastDurationMs: null });
  });

  it('treats an unknown or rotated token as not found and writes nothing', async () => {
    const { id, heartbeatToken } = await newHeartbeat();
    const old = heartbeatToken ?? '';

    expect(await pingAt(MINUTE, `mhb_${'x'.repeat(43)}`, { signal: 'success' })).toBe(false);
    expect(await current(id)).toMatchObject({ lastPingAt: null });

    const rotated = await status.statusMonitors.rotateHeartbeatToken(scope, actor, id);
    expect(rotated.token).not.toBe(old);
    expect(rotated.monitor).not.toHaveProperty('heartbeatTokenHash');
    expect(await pingAt(2 * MINUTE, old, { signal: 'success' })).toBe(false);
    expect(await pingAt(3 * MINUTE, rotated.token, { signal: 'success' })).toBe(true);
    expect(await current(id)).toMatchObject({ lastPingAt: at(3 * MINUTE) });
  });

  it('records pings while paused without moving the state, and resumes with a fresh deadline', async () => {
    const { id, heartbeatToken } = await newHeartbeat();
    const token = heartbeatToken ?? '';
    await pingAt(MINUTE, token, { signal: 'success' });
    clock = at(2 * MINUTE);
    await status.statusMonitors.pause(scope, actor, id);

    expect(await pingAt(3 * MINUTE, token, { signal: 'fail' })).toBe(true);
    expect(await current(id)).toMatchObject({ state: MonitorStates.paused, lastPingAt: at(3 * MINUTE) });
    // Silence while paused is never downtime.
    await evaluateAt(3 * WINDOW_MS);
    expect(await current(id)).toMatchObject({ state: MonitorStates.paused });

    clock = at(3 * WINDOW_MS);
    await status.statusMonitors.resume(scope, actor, id);
    expect(await current(id)).toMatchObject({ state: MonitorStates.pending, nextRoundAt: at(4 * WINDOW_MS) });
    await evaluateAt(3 * WINDOW_MS + MINUTE);
    expect(await current(id)).toMatchObject({ state: MonitorStates.pending });
  });

  it('applies a new period and grace to the deadline it is waiting on', async () => {
    const { id, heartbeatToken } = await newHeartbeat();
    await pingAt(MINUTE, heartbeatToken ?? '', { signal: 'success' });
    clock = at(2 * MINUTE);
    await status.statusMonitors.update(
      scope,
      actor,
      id,
      monitorInputSchema.parse({
        name: 'Nightly export',
        spec: { kind: MonitorKinds.heartbeat, periodSeconds: 3600, graceSeconds: 600 },
      }),
    );
    expect(await current(id)).toMatchObject({
      heartbeatPeriodSeconds: 3600,
      intervalSeconds: 3600,
      nextRoundAt: at(MINUTE + 4200 * SECOND),
    });
  });

  it('refuses a change of kind, an ad-hoc check, and a token for a probe monitor', async () => {
    const { id } = await newHeartbeat();
    const { location } = await status.statusLocations.create(scope.workspaceId, actor, { code: 'fra', name: 'F' });
    const http = monitorInputSchema.parse({
      name: 'API',
      spec: { kind: MonitorKinds.http, url: 'https://api.acme.test' },
      locationIds: [location.id],
    });
    await expect(status.statusMonitors.update(scope, actor, id, http)).rejects.toBeInstanceOf(MonitorKindError);
    await expect(status.statusMonitors.requestCheck(scope, id)).rejects.toBeInstanceOf(MonitorKindError);
    const probed = await status.statusMonitors.create(scope, actor, http);
    expect(probed.heartbeatToken).toBeNull();
    await expect(status.statusMonitors.rotateHeartbeatToken(scope, actor, probed.id)).rejects.toBeInstanceOf(
      MonitorKindError,
    );
  });

  it('is never leased to a probe or watched after a deploy', async () => {
    const { id } = await newHeartbeat();
    const location = await new LocationRepo(t.db).insert({
      workspaceId: null,
      code: 'fra',
      name: 'Frankfurt',
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(generateLocationToken()),
    });
    // Even an assignment row written behind the service's back leases nothing.
    await t.db
      .insert(statusMonitorLocations)
      .values({ monitorId: id, locationId: location.id, workspaceId: scope.workspaceId });
    clock = at(2 * WINDOW_MS);
    const probe = { id: location.id, workspaceId: null, kind: location.kind, code: location.code };
    const leased = await status.statusProbes.lease(probe, { agentVersion: '1', capacity: 50 });
    expect(leased.leases).toEqual([]);

    const watch = new DeployWatchService({ db: t.db, now: () => clock });
    const run = await watch.startWatch({
      workspaceId: scope.workspaceId,
      projectIds: [scope.projectId],
      runId: randomUUID(),
      releasedAt: clock,
    });
    expect(run.watched).toBe(0);
    expect(await current(id)).toMatchObject({ watchUntil: null });
  });

  it('counts silence downtime in the rollups like any outage', async () => {
    const { id, heartbeatToken } = await newHeartbeat();
    // The rollups count from the row's creation, which the DB stamped with the wall clock.
    await t.db.update(statusMonitors).set({ createdAt: T0 }).where(eq(statusMonitors.id, id));
    // Down at the first evaluation at its first deadline, then 20 minutes down until a ping.
    await evaluateAt(WINDOW_MS);
    expect(await current(id)).toMatchObject({ state: MonitorStates.down });
    await pingAt(WINDOW_MS + 20 * MINUTE, heartbeatToken ?? '', { signal: 'success' });

    await status.statusRollups.rollupDay('2026-10-05', at(6 * 60 * MINUTE));
    const [daily] = await t.db.select().from(statusRollupsDaily).where(eq(statusRollupsDaily.monitorId, id));
    expect(daily?.downSeconds).toBe(20 * 60);
    expect(Number(daily?.uptimeRatio)).toBeLessThan(1);
  });
});
