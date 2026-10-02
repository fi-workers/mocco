import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FlagEventTypes } from '@mocco/common/events';
import { StaleKinds } from '@mocco/common/flags';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { FlagService } from '@backend/domain/flags/FlagService';
import { FlagTelemetryService } from '@backend/domain/flags/FlagTelemetryService';
import { StaleFlagDetector } from '@backend/domain/flags/StaleFlagDetector';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, flagEnvironments, flagEvalRollups, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { ChangeOp } from '@mocco/common/flags';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('StaleFlagDetector (pglite)', () => {
  let t: TestDb;
  let flags: FlagService;
  let telemetry: FlagTelemetryService;
  let detector: StaleFlagDetector;
  let published: PublishInput[];
  let workspaceId: string;
  let projectId: string;
  let userId: string;
  let staging: string;
  let production: string;
  const t0 = new Date();
  const at = (days: number) => new Date(t0.getTime() + days * DAY_MS);

  const apply = async (environmentId: string, ops: ChangeOp[]) => {
    const environment = expectOne(
      await t.db.select().from(flagEnvironments).where(eq(flagEnvironments.id, environmentId)),
    );
    await flags.applyChangeset(workspaceId, projectId, userId, {
      environmentId,
      baseVersion: environment.currentVersion,
      ops,
      reason: null,
    });
  };
  const report = async (environmentId: string, flagKey: string, when: Date) =>
    await telemetry.ingest(
      { workspaceId, environmentId, keyKind: 'secret' },
      { evaluations: [{ flag: flagKey, variant: 'on', count: 3, windowStart: when.toISOString() }] },
      when,
    );
  const findingsAt = async (when?: Date) => {
    const findings = await detector.list(workspaceId, projectId, when);
    return findings.map(finding => `${finding.flagKey}:${finding.kind}`);
  };
  /** The finding of `flagKey` (any kind), dismissed or not. */
  const findingOf = async (flagKey: string) => {
    const findings = await detector.list(workspaceId, projectId);
    return findings.find(finding => finding.flagKey === flagKey);
  };

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    flags = new FlagService({ db: t.db, audit });
    telemetry = new FlagTelemetryService({ db: t.db });
    published = [];
    const events: EventPublisher = {
      publish: async input => {
        published.push(input);
        return await Promise.resolve({ event: {} as never, created: true, subscribers: [] });
      },
    };
    detector = new StaleFlagDetector({ db: t.db, audit, events, appOrigin: 'https://mocco.test' });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;
    const project = await createProjectDomain(t.db).projects.create(workspaceId, { name: 'Acme', handle: 'acme' });
    projectId = project.id;
    userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
    const stagingEnvironment = await flags.createEnvironment(workspaceId, projectId, userId, {
      key: 'staging',
      name: 'Staging',
    });
    const productionEnvironment = await flags.createEnvironment(workspaceId, projectId, userId, {
      key: 'production',
      name: 'Production',
    });
    staging = stagingEnvironment.id;
    production = productionEnvironment.id;
    const create = async (key: string, lifecycle: 'temporary' | 'permanent' = 'temporary') => {
      await flags.createBooleanFlag(workspaceId, projectId, userId, { key, description: null, lifecycle });
    };
    await create('old-unused');
    await create('never');
    await create('rolled');
    await create('split');
    await create('kept', 'permanent');
    await apply(staging, [
      { op: 'set_enabled', flagKey: 'rolled', enabled: true },
      { op: 'set_enabled', flagKey: 'split', enabled: true },
    ]);
    await apply(production, [{ op: 'set_enabled', flagKey: 'rolled', enabled: true }]);
    // old-unused was evaluated at the start only; rolled and split recently.
    await report(staging, 'old-unused', t0);
    await report(production, 'rolled', at(35));
    await report(staging, 'split', at(35));
  });
  afterEach(async () => {
    await t.close();
  });

  it('finds unused, never-evaluated and fully rolled-out temporary flags', async () => {
    expect(await detector.detectAll(at(40))).toEqual({ projects: 1, findings: 3 });

    const findings = await detector.list(workspaceId, projectId);
    expect(findings.map(finding => `${finding.flagKey}:${finding.kind}`)).toEqual([
      `never:${StaleKinds.neverEvaluated}`,
      `old-unused:${StaleKinds.unused}`,
      `rolled:${StaleKinds.fullyRolledOut}`,
    ]);
    const listedFlags = await flags.listFlags(workspaceId, projectId);
    const listed = listedFlags.find(flag => flag.key === 'rolled');
    expect(findings.find(finding => finding.flagKey === 'rolled')).toMatchObject({
      servedVariant: listed?.configs[0]?.defaultVariant,
      lastEvaluatedAt: at(35),
    });
    expect(findings.find(finding => finding.flagKey === 'old-unused')?.lastEvaluatedAt).toEqual(t0);
  });

  it('reports nothing before the stale period, and drops a finding once it no longer holds', async () => {
    expect(await detector.detectAll(at(20))).toEqual({ projects: 1, findings: 0 });

    await detector.detectAll(at(40));
    await report(staging, 'never', at(40));
    await apply(staging, [{ op: 'set_enabled', flagKey: 'rolled', enabled: false }]);
    await detector.detectAll(at(41));
    expect(await findingsAt()).toEqual([`old-unused:${StaleKinds.unused}`]);
  });

  it('hides a dismissed finding until its date, keeping the dismissal across runs', async () => {
    await detector.detectAll(at(40));
    const never = await findingOf('never');
    await detector.dismiss(workspaceId, projectId, userId, { findingId: never?.id ?? '', until: at(50) });

    await detector.detectAll(at(41));
    expect(await findingsAt(at(45))).not.toContain(`never:${StaleKinds.neverEvaluated}`);
    expect(await findingsAt(at(51))).toContain(`never:${StaleKinds.neverEvaluated}`);
    const kept = await findingOf('never');
    expect(kept).toMatchObject({ id: never?.id, detectedAt: at(40), dismissedUntil: at(50) });
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.flagStaleDismissed));
    expect(entry?.payload).toMatchObject({ kind: StaleKinds.neverEvaluated, until: at(50).toISOString() });
  });

  it('prunes old rollup buckets but keeps each flag’s newest, so "last evaluated" survives', async () => {
    await report(staging, 'old-unused', at(1));
    await report(staging, 'old-unused', at(2));
    expect(await detector.pruneRollups(at(200))).toBeGreaterThanOrEqual(2);

    const left = await t.db.select().from(flagEvalRollups).where(eq(flagEvalRollups.flagKey, 'old-unused'));
    expect(left).toHaveLength(1);
    await detector.detectAll(at(200));
    expect(await findingOf('old-unused')).toMatchObject({
      kind: StaleKinds.unused,
      lastEvaluatedAt: at(2),
    });
  });

  it('sends one digest per project and week with the active findings', async () => {
    await detector.detectAll(at(40));
    const never = await findingOf('never');
    await detector.dismiss(workspaceId, projectId, userId, { findingId: never?.id ?? '', until: at(50) });

    expect(await detector.sendDigests(at(40))).toBe(1);
    const [digest] = published;
    expect(digest).toMatchObject({
      type: FlagEventTypes.flagStaleDigest,
      projectId,
      dedupeKey: expect.stringMatching(new RegExp(String.raw`^${projectId}:stale:\d+$`, 'u')),
      payload: {
        message: {
          title: '2 flags to clean up in Acme',
          url: `https://mocco.test/workspaces/${workspaceId}/p/${projectId}/flags`,
        },
      },
    });
    const { description } = (digest?.payload as { message: { description?: string } } | undefined)?.message ?? {};
    expect(description).toContain('• old-unused: not evaluated lately');
    expect(description).not.toContain('never');
  });
});
