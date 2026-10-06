import { randomUUID } from 'node:crypto';

import { StatusEventTypes } from '@mocco/common/events';
import { CheckOutcomes, LocationKinds, MonitorKinds, MonitorStates, monitorInputSchema } from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createTestEventBus } from '@backend/domain/events/testing/event-bus';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import {
  domainEvents,
  statusMonitors,
  statusMonitorStateChanges,
  statusRoundVerdicts,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { ProbeLease, ProbeLocation } from '@backend/domain/status/ProbeService';
import type { StatusScope } from '@backend/domain/status/scope';
import type { CheckOutcome, MonitorInput } from '@mocco/common/status';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const seconds = (n: number) => new Date(T0.getTime() + n * 1000);

/** A result for a lease, as a probe reports it. */
const resultOf = (lease: ProbeLease, outcome: CheckOutcome, latencyMs = 100, tlsExpiresAt?: Date) => ({
  leaseId: lease.leaseId,
  monitorId: lease.monitorId,
  roundAt: lease.roundAt,
  outcome: outcome === CheckOutcomes.ok ? CheckOutcomes.ok : CheckOutcomes.fail,
  latencyMs,
  ...(tlsExpiresAt !== undefined && { tlsExpiresAt }),
});
const DAY_MS = 24 * 60 * 60 * 1000;

describe('verdict evaluator (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let scope: StatusScope;
  let actor: string;
  let clock: Date;

  const hosted = async (code: string): Promise<ProbeLocation> => {
    const token = generateLocationToken();
    await new LocationRepo(t.db).insert({
      workspaceId: null,
      code,
      name: code,
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(token),
    });
    const location = await status.statusProbes.authenticate(token);
    if (location === undefined) {
      throw new Error('fixture location did not authenticate');
    }
    return location;
  };

  const monitor = async (locationIds: string[], extra: Partial<MonitorInput> = {}) =>
    await status.statusMonitors.create(
      scope,
      actor,
      monitorInputSchema.parse({
        name: 'API',
        spec: { kind: MonitorKinds.http, url: 'https://api.acme.test/health' },
        locationIds,
        ...extra,
      }),
    );

  /** Lease at `location` now and report `outcome` for every round it got; the rounds leased. */
  const probeRound = async (location: ProbeLocation, outcome: CheckOutcome, latencyMs = 100, tlsExpiresAt?: Date) => {
    const { leases } = await status.statusProbes.lease(location, { agentVersion: '1', capacity: 10 });
    if (leases.length > 0) {
      await status.statusProbes.report(
        location,
        leases.map(lease => resultOf(lease, outcome, latencyMs, tlsExpiresAt)),
      );
    }
    return leases.map(lease => lease.roundAt);
  };

  const transitions = async () => {
    const rows = await t.db.select().from(statusMonitorStateChanges).orderBy(statusMonitorStateChanges.at);
    return rows.map(row => `${row.fromState}→${row.toState}`);
  };

  const current = async () => expectOne(await t.db.select().from(statusMonitors));

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    status = createStatusDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      events: createTestEventBus(t.db, () => clock),
      now: () => clock,
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

  it('confirms an outage, rechecks at once on suspect, and recovers over several rounds', async () => {
    const fra = await hosted('fra');
    await monitor([fra.id]);

    // Round 1 fails: suspect, and the recheck is due now, not in a minute.
    clock = seconds(5);
    expect(await probeRound(fra, CheckOutcomes.fail)).toEqual([T0]);
    expect(await current()).toMatchObject({
      state: MonitorStates.suspect,
      nextRoundAt: seconds(5),
      consecutiveFails: 1,
    });
    // The recheck fails too: two confirmations, down. The next round is an interval later.
    clock = seconds(8);
    expect(await probeRound(fra, CheckOutcomes.fail)).toEqual([seconds(5)]);
    expect(await current()).toMatchObject({ state: MonitorStates.down, nextRoundAt: seconds(65) });
    // That round is within the lookahead, so it is leased now; a result before its time is refused.
    const { leases: early } = await status.statusProbes.lease(fra, { agentVersion: '1', capacity: 10 });
    expect(early.map(lease => lease.roundAt)).toEqual([seconds(65)]);
    const tooEarly = await status.statusProbes.report(
      fra,
      early.map(lease => resultOf(lease, CheckOutcomes.ok)),
    );
    expect(tooEarly.rejected).toHaveLength(1);
    clock = seconds(66);
    const onTime = await status.statusProbes.report(
      fra,
      early.map(lease => resultOf(lease, CheckOutcomes.ok)),
    );
    expect(onTime.accepted).toBe(1);
    expect(await current()).toMatchObject({ state: MonitorStates.recovering, nextRoundAt: seconds(125) });
    clock = seconds(126);
    expect(await probeRound(fra, CheckOutcomes.ok)).toEqual([seconds(125)]);

    expect(await current()).toMatchObject({ state: MonitorStates.up, consecutiveOks: 2, consecutiveFails: 0 });
    expect(await transitions()).toEqual(['pending→suspect', 'suspect→down', 'down→recovering', 'recovering→up']);
    const verdicts = await t.db.select().from(statusRoundVerdicts).orderBy(statusRoundVerdicts.roundAt);
    expect(verdicts.map(row => [row.roundAt, row.verdict, row.okCount, row.failCount, row.noDataCount])).toEqual([
      [T0, 'fail', 0, 1, 0],
      [seconds(5), 'fail', 0, 1, 0],
      [seconds(65), 'ok', 1, 0, 0],
      [seconds(125), 'ok', 1, 0, 0],
    ]);
    const [change] = await t.db.select().from(statusMonitorStateChanges).orderBy(statusMonitorStateChanges.at);
    expect(change).toMatchObject({ roundAt: T0, at: seconds(5), reason: { by: 'evaluator', verdict: 'fail' } });
  });

  it('waits for every location until the deadline, then counts the silent one as no_data', async () => {
    const fra = await hosted('fra');
    const iad = await hosted('iad');
    await monitor([fra.id, iad.id]);
    await status.statusProbes.lease(iad, { agentVersion: '1', capacity: 10 });

    clock = seconds(5);
    await probeRound(fra, CheckOutcomes.ok);
    expect(await status.statusVerdicts.evaluate()).toEqual({ closed: 0, changed: 0 });
    // The round's deadline: its time, the 10 s timeout and the 15 s grace.
    clock = seconds(25);
    expect(await status.statusVerdicts.evaluate()).toEqual({ closed: 0, changed: 0 });
    clock = seconds(26);
    expect(await status.statusVerdicts.evaluate()).toEqual({ closed: 1, changed: 1 });

    const verdict = expectOne(await t.db.select().from(statusRoundVerdicts));
    expect(verdict).toMatchObject({ verdict: 'ok', okCount: 1, failCount: 0, noDataCount: 1, p50LatencyMs: 100 });
    expect(await current()).toMatchObject({ state: MonitorStates.up, nextRoundAt: seconds(60) });
  });

  it('never counts a round nobody reported as down, and leasing resumes on the next round', async () => {
    const fra = await hosted('fra');
    await monitor([fra.id], { confirmations: 1 });

    clock = seconds(26);
    expect(await status.statusVerdicts.evaluate()).toEqual({ closed: 1, changed: 0 });
    expect(await current()).toMatchObject({ state: MonitorStates.pending, nextRoundAt: seconds(60) });
    expect(expectOne(await t.db.select().from(statusRoundVerdicts))).toMatchObject({
      verdict: 'unknown',
      noDataCount: 1,
    });

    clock = seconds(61);
    expect(await probeRound(fra, CheckOutcomes.fail)).toEqual([seconds(60)]);
    expect(await current()).toMatchObject({ state: MonitorStates.down });
    expect(await transitions()).toEqual(['pending→down']);
  });

  it('marks a quorum of slow passing checks degraded', async () => {
    const fra = await hosted('fra');
    await monitor([fra.id], {
      spec: monitorInputSchema.shape.spec.parse({
        kind: MonitorKinds.http,
        url: 'https://api.acme.test/health',
        latencyThresholdMs: 500,
      }),
    });

    clock = seconds(5);
    await probeRound(fra, CheckOutcomes.ok, 900);

    expect(await current()).toMatchObject({ state: MonitorStates.degraded });
  });

  it('closes a round once under concurrent evaluations and leaves paused monitors alone', async () => {
    const fra = await hosted('fra');
    const paused = await monitor([fra.id]);
    await status.statusMonitors.pause(scope, actor, paused.id);
    await monitor([fra.id]);

    clock = seconds(26);
    const [first, second] = await Promise.all([status.statusVerdicts.evaluate(), status.statusVerdicts.evaluate()]);

    expect(first.closed + second.closed).toBe(1);
    expect(await t.db.select().from(statusRoundVerdicts)).toHaveLength(1);
    const rows = await t.db.select().from(statusMonitors);
    expect(rows.find(row => row.id === paused.id)).toMatchObject({ state: MonitorStates.paused, nextRoundAt: T0 });
  });
  it('never takes a majority monitor down for a single failing region (#151)', async () => {
    const fra = await hosted('fra');
    const iad = await hosted('iad');
    const sin = await hosted('sin');
    await monitor([fra.id, iad.id, sin.id], { confirmations: 1 });

    // Six rounds with fra failing every one; from the fourth, iad is silent and fra fails beside sin.
    const rounds = [0, 1, 2, 3, 4, 5];
    await rounds.reduce(async (previous, round) => {
      await previous;
      clock = seconds(round * 60 + 5);
      await probeRound(fra, CheckOutcomes.fail);
      if (round < 3) {
        await probeRound(iad, CheckOutcomes.ok);
      }
      await probeRound(sin, CheckOutcomes.ok);
      // A round iad didn't report closes at its deadline.
      clock = seconds(round * 60 + 26);
      await status.statusVerdicts.evaluate();
    }, Promise.resolve());

    expect(await current()).toMatchObject({ state: MonitorStates.up, consecutiveFails: 0 });
    expect(await transitions()).toEqual(['pending→up']);
    const verdicts = await t.db.select().from(statusRoundVerdicts).orderBy(statusRoundVerdicts.roundAt);
    expect(verdicts.map(row => [row.verdict, row.failCount, row.noDataCount])).toEqual([
      ['ok', 1, 0],
      ['ok', 1, 0],
      ['ok', 1, 0],
      ['ok', 1, 1],
      ['ok', 1, 1],
      ['ok', 1, 1],
    ]);
  });

  it('warns once at each TLS threshold as the certificate runs out, and again after a renewal (#151)', async () => {
    const fra = await hosted('fra');
    const iad = await hosted('iad');
    const created = await monitor([fra.id, iad.id], {
      spec: monitorInputSchema.shape.spec.parse({
        kind: MonitorKinds.http,
        url: 'https://api.acme.test/health',
        tlsWarnDays: 14,
      }),
    });
    // The days left each round as fra saw them; iad sees a certificate a day later (the earliest counts).
    const daysLeft = [20, 13.5, 13, 6.5, 6, 2.5, 2, 60, 13.2];
    await daysLeft.reduce(async (previous, days, round) => {
      await previous;
      clock = seconds(round * 60 + 5);
      await probeRound(fra, CheckOutcomes.ok, 100, new Date(clock.getTime() + days * DAY_MS));
      await probeRound(iad, CheckOutcomes.ok, 100, new Date(clock.getTime() + (days + 1) * DAY_MS));
    }, Promise.resolve());

    const events = await t.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.type, StatusEventTypes.statusMonitorTlsExpiring))
      .orderBy(domainEvents.occurredAt);
    const facts = events.map(event => (event.payload as { facts: { thresholdDays: string; daysLeft: string } }).facts);
    expect(facts.map(fact => [fact.thresholdDays, fact.daysLeft])).toEqual([
      ['14', '13'],
      ['7', '6'],
      ['3', '2'],
      ['14', '13'],
    ]);
    expect(await current()).toMatchObject({ id: created.id, state: MonitorStates.up, tlsWarnedDays: 14 });
    // A warning is a separate signal: the monitor never left up.
    expect(await transitions()).toEqual(['pending→up']);
  });

  it('leaves a monitor without tlsWarnDays alone', async () => {
    const fra = await hosted('fra');
    await monitor([fra.id]);
    clock = seconds(5);
    await probeRound(fra, CheckOutcomes.ok, 100, new Date(clock.getTime() + DAY_MS));
    expect(await current()).toMatchObject({ tlsWarnedDays: null });
    expect(await t.db.select().from(domainEvents)).toHaveLength(0);
  });
});
