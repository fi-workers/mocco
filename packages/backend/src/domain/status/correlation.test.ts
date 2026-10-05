import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { RunStates } from '@mocco/common/execution';
import { IncidentRunRelations, IncidentSeverities, IncidentStatuses } from '@mocco/common/status';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import {
  correlationWindow,
  deployScore,
  LINKED_REPO_FACTOR,
  MAX_SUGGESTED_RUNS,
  rankReleases,
} from '@backend/domain/status/CorrelationService';
import { StatusEntityNotFoundError } from '@backend/domain/status/errors';
import { seedRelease, seedRepo, seedRun } from '@backend/domain/status/testing/deploys';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';

const T0 = new Date('2026-10-05T09:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('correlation scoring', () => {
  it('spans two hours before the start to five minutes after', () => {
    expect(correlationWindow(T0)).toEqual({ from: minutes(-120), to: minutes(5) });
  });

  it('scores 1 / (1 + minutes / 10) from the start, either side, and 1.5x for a linked repo', () => {
    expect(deployScore({ releasedAt: T0 }, T0, false)).toBe(1);
    expect(deployScore({ releasedAt: minutes(-10) }, T0, false)).toBe(0.5);
    expect(deployScore({ releasedAt: minutes(5) }, T0, false)).toBeCloseTo(2 / 3);
    expect(deployScore({ releasedAt: minutes(-10) }, T0, true)).toBe(0.5 * LINKED_REPO_FACTOR);
  });

  it('keeps one suggestion per run, best first: the best is suspected, the rest before_window', () => {
    const incident = { startedAt: T0, projectId: 'p1' };
    const ranked = rankReleases(
      [
        { runId: 'far', projectId: 'p1', releasedAt: minutes(-90) },
        { runId: 'near', projectId: 'p2', releasedAt: minutes(-2) },
        { runId: 'near', projectId: 'p1', releasedAt: minutes(-2) },
      ],
      incident,
      true,
    );
    expect(ranked.map(row => [row.runId, row.relation])).toEqual([
      ['near', IncidentRunRelations.suspected],
      ['far', IncidentRunRelations.beforeWindow],
    ]);
    // The p1 row (a linked repo of the incident's project) wins over the p2 row of the same run.
    expect(ranked[0]?.score).toBeCloseTo((1 / 1.2) * LINKED_REPO_FACTOR);
    const many = Array.from({ length: MAX_SUGGESTED_RUNS + 5 }, (_, index) => ({
      runId: `run-${String(index)}`,
      projectId: 'p1',
      releasedAt: minutes(-index),
    }));
    expect(rankReleases(many, incident, true)).toHaveLength(MAX_SUGGESTED_RUNS);
  });
});

describe('CorrelationService (pglite)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let workspaceId: string;
  let actor: string;
  let clock: Date;

  const actions = async () => {
    const rows = await t.db
      .select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog)
      .orderBy(auditLog.seq);
    return rows.map(row => [row.action, row.payload]);
  };

  const newWorkspace = async () =>
    expectOne(await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning()).id;

  const newProject = async (ws: string, handle: string): Promise<StatusScope> => {
    const project = await createProjectDomain(t.db).projects.create(ws, { name: handle, handle });
    return { workspaceId: ws, projectId: project.id };
  };

  /** Open an incident on a fresh page of the project at T0. */
  const openIncident = async (scope: StatusScope, slug: string) => {
    const page = await status.statusPages.createPage(scope, actor, { slug, title: 'Status' });
    return await status.statusIncidents.create(scope, actor, {
      pageId: page.id,
      title: 'Errors',
      severity: IncidentSeverities.major,
      status: IncidentStatuses.investigating,
      body: 'Looking into it',
      components: [],
    });
  };

  const linked = async (scope: StatusScope, incidentId: string) => {
    const rows = await status.statusCorrelation.list(scope, incidentId);
    return rows.map(row => [row.runId, row.relation] as const);
  };

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    status = createStatusDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), now: () => clock });
    workspaceId = await newWorkspace();
    actor = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@acme.test`, name: 'Ada' })
        .returning(),
    ).id;
  });
  afterEach(async () => {
    await t.close();
  });

  it("suggests only the project's releases of its linked repos inside the window", async () => {
    const acme = await newProject(workspaceId, 'acme');
    const other = await newProject(workspaceId, 'other');
    const api = await seedRepo(t.db, workspaceId, 'api', [acme.projectId]);
    const web = await seedRepo(t.db, workspaceId, 'web', [other.projectId]);
    // Released for acme while linked, then unlinked: its later releases don't count.
    const legacy = await seedRepo(t.db, workspaceId, 'legacy');
    const release = async (repoId: string, projectId: string, at: number) =>
      await seedRelease(t.db, { workspaceId, repoId, projectIds: [projectId], releasedAt: minutes(at) });

    const justAfter = await release(api, acme.projectId, 3);
    const before = await release(api, acme.projectId, -10);
    const edge = await release(api, acme.projectId, -120);
    await release(api, acme.projectId, -121);
    await release(api, acme.projectId, 6);
    await release(web, other.projectId, -1);
    await release(legacy, acme.projectId, -1);
    // A run that succeeded without passing a gate is not a release.
    await seedRun(t.db, { workspaceId, repoId: api, finishedAt: minutes(-1) });

    const incident = await openIncident(acme, 'acme');

    expect(await linked(acme, incident.id)).toEqual([
      [justAfter, IncidentRunRelations.suspected],
      [before, IncidentRunRelations.beforeWindow],
      [edge, IncidentRunRelations.beforeWindow],
    ]);
    const [first] = await status.statusCorrelation.list(acme, incident.id);
    expect(first).toMatchObject({
      score: expect.closeTo((1 / 1.3) * LINKED_REPO_FACTOR, 5) as number,
      linkedByUserId: null,
      run: { state: RunStates.succeeded, repoFullName: 'acme/api', finishedAt: minutes(3) },
    });
    // Suggestions are not audited; the incident's opening is.
    const audited = await actions();
    expect(audited.map(([action]) => action)).toEqual([
      AuditActions.statusPageCreated,
      AuditActions.statusIncidentCreated,
    ]);
  });

  it("counts every release of the workspace when the project links no repo, and never another workspace's", async () => {
    const acme = await newProject(workspaceId, 'acme');
    const bare = await newProject(workspaceId, 'bare');
    const api = await seedRepo(t.db, workspaceId, 'api', [acme.projectId]);
    const mine = await seedRelease(t.db, {
      workspaceId,
      repoId: api,
      projectIds: [acme.projectId],
      releasedAt: minutes(-10),
    });
    const elsewhere = await newWorkspace();
    const theirs = await newProject(elsewhere, 'theirs');
    const theirRepo = await seedRepo(t.db, elsewhere, 'api', [theirs.projectId]);
    const foreign = await seedRelease(t.db, {
      workspaceId: elsewhere,
      repoId: theirRepo,
      projectIds: [theirs.projectId],
      releasedAt: minutes(-1),
    });

    const incident = await openIncident(bare, 'bare');

    expect(await linked(bare, incident.id)).toEqual([[mine, IncidentRunRelations.suspected]]);
    // Not the incident's project's repo, so no linked-repo factor.
    const [only] = await status.statusCorrelation.list(bare, incident.id);
    expect(only?.score).toBe(0.5);
    await expect(status.statusCorrelation.incidentsForRun(workspaceId, foreign)).rejects.toBeInstanceOf(
      StatusEntityNotFoundError,
    );
    await expect(
      status.statusCorrelation.link(bare, actor, {
        incidentId: incident.id,
        runId: foreign,
        relation: IncidentRunRelations.manual,
      }),
    ).rejects.toBeInstanceOf(StatusEntityNotFoundError);
    // Another workspace's incident is not found with its own run either.
    await expect(status.statusCorrelation.list(theirs, incident.id)).rejects.toBeInstanceOf(StatusEntityNotFoundError);
  });

  it('links and unlinks runs by hand with audit entries, and keeps those links when recomputing', async () => {
    const acme = await newProject(workspaceId, 'acme');
    const api = await seedRepo(t.db, workspaceId, 'api', [acme.projectId]);
    const suggested = await seedRelease(t.db, {
      workspaceId,
      repoId: api,
      projectIds: [acme.projectId],
      releasedAt: minutes(-5),
    });
    const incident = await openIncident(acme, 'acme');
    // A later run (no release) that fixed it.
    const { runId: fix } = await seedRun(t.db, { workspaceId, repoId: api, finishedAt: minutes(40) });
    const { runId: failed } = await seedRun(t.db, {
      workspaceId,
      repoId: api,
      finishedAt: minutes(-30),
      state: RunStates.failed,
    });

    const link = await status.statusCorrelation.link(acme, actor, {
      incidentId: incident.id,
      runId: fix,
      relation: IncidentRunRelations.fix,
    });
    expect(link).toMatchObject({ runId: fix, relation: IncidentRunRelations.fix, score: null, linkedByUserId: actor });
    await status.statusCorrelation.link(acme, actor, {
      incidentId: incident.id,
      runId: failed,
      relation: IncidentRunRelations.manual,
    });
    // Linking a suggested run makes it the person's link.
    await status.statusCorrelation.link(acme, actor, {
      incidentId: incident.id,
      runId: suggested,
      relation: IncidentRunRelations.manual,
    });
    expect(await status.statusCorrelation.correlate(acme, incident.id)).toEqual({ suggested: 1 });
    expect(new Map(await linked(acme, incident.id))).toEqual(
      new Map([
        [fix, IncidentRunRelations.fix],
        [failed, IncidentRunRelations.manual],
        [suggested, IncidentRunRelations.manual],
      ]),
    );

    await status.statusCorrelation.unlink(acme, actor, { incidentId: incident.id, runId: failed });
    await expect(
      status.statusCorrelation.unlink(acme, actor, { incidentId: incident.id, runId: failed }),
    ).rejects.toBeInstanceOf(StatusEntityNotFoundError);

    const audited = await actions();
    expect(audited.slice(2)).toEqual([
      [AuditActions.statusIncidentRunLinked, { runId: fix, relation: IncidentRunRelations.fix }],
      [AuditActions.statusIncidentRunLinked, { runId: failed, relation: IncidentRunRelations.manual }],
      [AuditActions.statusIncidentRunLinked, { runId: suggested, relation: IncidentRunRelations.manual }],
      [AuditActions.statusIncidentRunUnlinked, { runId: failed, relation: IncidentRunRelations.manual }],
    ]);
    // The run's side lists the incident.
    expect(await status.statusCorrelation.incidentsForRun(workspaceId, fix)).toEqual([
      expect.objectContaining({
        incidentId: incident.id,
        projectId: acme.projectId,
        title: 'Errors',
        relation: IncidentRunRelations.fix,
      }),
    ]);
    expect(await status.statusCorrelation.incidentsForRun(workspaceId, failed)).toEqual([]);
  });

  it('recomputes suggestions on demand, for releases recorded after the incident opened', async () => {
    const acme = await newProject(workspaceId, 'acme');
    const api = await seedRepo(t.db, workspaceId, 'api', [acme.projectId]);
    const incident = await openIncident(acme, 'acme');
    expect(await linked(acme, incident.id)).toEqual([]);

    const late = await seedRelease(t.db, {
      workspaceId,
      repoId: api,
      projectIds: [acme.projectId],
      releasedAt: minutes(2),
    });
    expect(await status.statusCorrelation.correlate(acme, incident.id)).toEqual({ suggested: 1 });
    expect(await linked(acme, incident.id)).toEqual([[late, IncidentRunRelations.suspected]]);
  });
});
