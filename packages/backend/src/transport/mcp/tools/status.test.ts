// `mocco_status_*` over a real database, through the real HTTP handler.
//
// The reads are only as safe as the scoping in front of them, so many of these tests are
// about what a caller cannot see: a workspace they are not in reads the same whether it
// exists or not, a page, incident or project of another workspace reads the same as one
// that does not exist, and a workspace without the status product says so.
import { randomUUID } from 'node:crypto';

import { RunStates } from '@mocco/common/execution';
import { Products } from '@mocco/common/project';
import { ComponentStatuses, IncidentRunRelations, IncidentSeverities, IncidentStatuses } from '@mocco/common/status';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { seedRelease, seedRepo, seedRun } from '@backend/domain/status/testing/deploys';
import { expectOne } from '@backend/infra/db/rows';
import { members, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { ProjectDomain } from '@backend/domain/project/instance';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const refuse = () => {
  throw new Error('the status tools must not reach another domain');
};

interface RpcAnswer {
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
  };
  error?: { code: number; message: string };
}

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

/** A successful answer's JSON; fails the test on a refusal, showing why. */
function bodyOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Record<string, unknown>;
}

type Row = Record<string, unknown>;

const T0 = new Date('2026-10-05T09:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const slug = () => `s${randomUUID().slice(0, 8)}`;

const STATUS_TOOLS = [
  'mocco_status_incidents_get',
  'mocco_status_incidents_search',
  'mocco_status_maintenances_search',
  'mocco_status_pages_get',
];

/** Every status tool, with the monitor and location reads (`status-monitors.test.ts`). */
const ALL_STATUS_TOOLS = [
  ...STATUS_TOOLS,
  'mocco_status_locations_search',
  'mocco_status_monitors_get',
  'mocco_status_monitors_search',
];

describe('mocco_status_* (pglite, over HTTP)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let project: ProjectDomain;
  let handler: McpHttpHandler;
  let clock: Date;
  let ada: string;
  let mine: StatusScope;
  let theirs: StatusScope;
  let pageId: string;
  let api: string;
  let dashboard: string;
  let loginOutage: string;
  let elevatedErrors: string;
  let slowDashboard: string;
  let running: string;
  let canceled: string;
  let theirPage: string;
  let theirIncident: string;

  async function rpc(userId: string, method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
    const name = typeof params.name === 'string' ? params.name : undefined;
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': method,
        ...(name !== undefined && { 'mcp-name': name }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope } }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: 'agent',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: userId },
      },
    });
    const text = await response.text();
    return (text === '' ? {} : JSON.parse(text)) as RpcAnswer;
  }

  const call = async (tool: string, args: Record<string, unknown>, userId = ada) =>
    await rpc(userId, 'tools/call', { name: tool, arguments: args });

  async function addWorkspace(memberId?: string): Promise<StatusScope> {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    if (memberId !== undefined) {
      await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'owner' });
    }
    await project.products.enable(workspaceId, Products.status, ada);
    const created = await project.projects.create(workspaceId, { name: 'Shop', handle: 'shop' });
    return { workspaceId, projectId: created.id };
  }

  /** The ids of the incidents a search finds, in its order. */
  async function incidentIds(args: Record<string, unknown>) {
    const { incidents } = bodyOf(await call('mocco_status_incidents_search', args));
    return (incidents as Row[]).map(incident => incident.id);
  }

  /** Opens an incident at `at`, as Ada. */
  async function open(at: Date, input: Parameters<StatusDomain['statusIncidents']['create']>[2], scope = mine) {
    clock = at;
    return await status.statusIncidents.create(scope, ada, input);
  }

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    status = createStatusDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), now: () => clock });
    project = createProjectDomain(t.db);
    ada = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    mine = await addWorkspace(ada);
    theirs = await addWorkspace();

    // One page: API (in the Core group) and Dashboard, both operational by hand.
    const page = await status.statusPages.createPage(mine, ada, { slug: slug(), title: 'Acme status' });
    pageId = page.id;
    const core = await status.statusPages.createGroup(mine, pageId, { name: 'Core' });
    ({ id: api } = await status.statusPages.createComponent(mine, pageId, { name: 'API', groupId: core.id }));
    ({ id: dashboard } = await status.statusPages.createComponent(mine, pageId, { name: 'Dashboard' }));

    // A resolved outage with a postmortem, an open incident hurting the API, and a newer
    // open one that affects nothing.
    ({ id: loginOutage } = await open(T0, {
      pageId,
      title: 'Login outage',
      severity: IncidentSeverities.critical,
      status: IncidentStatuses.investigating,
      body: 'Sign-ins fail',
      components: [],
    }));
    clock = minutes(1);
    await status.statusIncidents.postUpdate(mine, ada, loginOutage, {
      status: IncidentStatuses.resolved,
      body: 'Sign-ins work again',
    });
    await status.statusIncidents.setPostmortem(mine, ada, loginOutage, 'An expired certificate.');
    ({ id: elevatedErrors } = await open(minutes(10), {
      pageId,
      title: 'Elevated errors',
      severity: IncidentSeverities.major,
      status: IncidentStatuses.investigating,
      body: 'Looking into it',
      components: [{ componentId: api, impact: ComponentStatuses.partialOutage }],
    }));
    clock = minutes(15);
    await status.statusIncidents.postUpdate(mine, ada, elevatedErrors, {
      status: IncidentStatuses.identified,
      body: 'A bad deploy; rolling back',
    });
    ({ id: slowDashboard } = await open(minutes(20), {
      pageId,
      title: 'Slow dashboard',
      severity: IncidentSeverities.minor,
      status: IncidentStatuses.investigating,
      body: 'Pages load slowly',
      components: [],
    }));

    // A window in progress over the Dashboard, and a canceled one.
    ({ id: running } = await status.statusMaintenances.schedule(mine, ada, {
      pageId,
      title: 'Database upgrade',
      body: 'Read-only for a while',
      scheduledStart: minutes(20),
      scheduledEnd: minutes(200),
      componentIds: [dashboard],
    }));
    ({ id: canceled } = await status.statusMaintenances.schedule(mine, ada, {
      pageId,
      title: 'Network work',
      body: '',
      scheduledStart: minutes(300),
      scheduledEnd: minutes(360),
      componentIds: [],
    }));
    await status.statusMaintenances.cancel(mine, ada, canceled);
    await status.statusMaintenances.tick(minutes(30));

    // Another workspace, with its own page and incident, that Ada is not in.
    ({ id: theirPage } = await status.statusPages.createPage(theirs, ada, { slug: slug(), title: 'Their status' }));
    ({ id: theirIncident } = await open(
      minutes(40),
      {
        pageId: theirPage,
        title: 'Their secret incident',
        severity: IncidentSeverities.major,
        status: IncidentStatuses.investigating,
        body: 'Shh',
        components: [],
      },
      theirs,
    ));

    const scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    handler = createMcpHttpHandler({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals: { list: refuse, get: refuse, vote: refuse },
      gates: { getPending: refuse, resume: refuse },
      flags: { listFlags: refuse, listEnvironments: refuse, history: refuse },
      otaHosting: { listApps: refuse, requireApp: refuse, listChannels: refuse },
      otaChannels: { listHeads: refuse },
      otaReleases: { listReleases: refuse },
      otaMetrics: { channelReach: refuse, monthlyActiveDevices: refuse },
      versionPolicies: { get: refuse, listChanges: refuse },
      projectApps: { listApps: refuse },
      statusPages: status.statusPages,
      statusIncidents: status.statusIncidents,
      statusMaintenances: status.statusMaintenances,
      statusMonitors: status.statusMonitors,
      statusLocations: status.statusLocations,
      statusCorrelation: status.statusCorrelation,
      helpPublic: { searchInProject: refuse, siteInProject: refuse, articleInProject: refuse },
      scope,
      projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
      settings: { agentsMayDecide: refuse },
      confirmations: undefined,
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('declares every status tool read-only', async () => {
    const listed = await rpc(ada, 'tools/list', {});

    const statusTools = listed.result?.tools?.filter(tool => tool.name.startsWith('mocco_status_')) ?? [];
    expect(new Set(statusTools.map(tool => tool.name))).toEqual(new Set(ALL_STATUS_TOOLS));
    expect(statusTools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  describe('mocco_status_pages_get', () => {
    it("shows each component's derived status on the project's only page, without being told which", async () => {
      const body = bodyOf(await call('mocco_status_pages_get', {}));

      expect(body.page).toEqual({ id: pageId, slug: expect.any(String), title: 'Acme status' });
      // Both are operational by hand: the incident and the window are what the page shows.
      expect(body.components).toEqual([
        { id: api, name: 'API', group: 'Core', status: ComponentStatuses.partialOutage },
        { id: dashboard, name: 'Dashboard', group: null, status: ComponentStatuses.maintenance },
      ]);
      expect(body).not.toHaveProperty('groups');
    });

    it('adds the status set by hand and the groups when asked', async () => {
      const body = bodyOf(await call('mocco_status_pages_get', { pageId, responseFormat: 'detailed' }));

      expect((body.components as Row[])[0]).toMatchObject({
        status: ComponentStatuses.partialOutage,
        manualStatus: ComponentStatuses.operational,
        description: null,
      });
      expect(body.groups).toEqual([{ id: expect.any(String), name: 'Core' }]);
    });

    it('names the pages to choose from when the project has more than one', async () => {
      const second = await status.statusPages.createPage(mine, ada, { slug: slug(), title: 'Partner status' });

      const answer = await call('mocco_status_pages_get', {});

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain(`Partner status (${second.id})`);
      expect(textOf(answer)).toContain(`Acme status (${pageId})`);
    });
  });

  describe('mocco_status_incidents_search', () => {
    it('finds open incidents newest first, concise unless asked', async () => {
      const body = bodyOf(await call('mocco_status_incidents_search', {}));
      const incidents = body.incidents as Row[];

      expect(body.pages).toEqual([{ id: pageId, slug: expect.any(String), title: 'Acme status' }]);
      expect(incidents.map(incident => incident.id)).toEqual([slowDashboard, elevatedErrors]);
      expect(incidents[1]).toEqual({
        id: elevatedErrors,
        pageId,
        title: 'Elevated errors',
        status: IncidentStatuses.identified,
        severity: IncidentSeverities.major,
        startedAt: minutes(10).toISOString(),
        resolvedAt: null,
      });
      expect(body).not.toHaveProperty('nextBefore');
    });

    it('adds the affected components and the latest update when asked', async () => {
      const body = bodyOf(
        await call('mocco_status_incidents_search', { severity: 'major', responseFormat: 'detailed' }),
      );

      expect(body.incidents).toEqual([
        expect.objectContaining({
          id: elevatedErrors,
          identifiedAt: minutes(15).toISOString(),
          affectedComponents: [{ componentId: api, name: 'API', impact: ComponentStatuses.partialOutage }],
          latestUpdate: {
            status: IncidentStatuses.identified,
            body: 'A bad deploy; rolling back',
            createdAt: expect.any(String),
          },
        }),
      ]);
    });

    it('filters by status, severity and title text', async () => {
      expect(await incidentIds({ status: 'all' })).toEqual([slowDashboard, elevatedErrors, loginOutage]);
      expect(await incidentIds({ status: 'resolved' })).toEqual([loginOutage]);
      expect(await incidentIds({ status: 'investigating' })).toEqual([slowDashboard]);
      expect(await incidentIds({ status: 'all', severity: 'critical' })).toEqual([loginOutage]);
      expect(await incidentIds({ status: 'all', query: 'ELEVATED' })).toEqual([elevatedErrors]);
      expect(await incidentIds({ query: 'login' })).toEqual([]);
    });

    it('pages newest first, and says where the next page starts only when there is one', async () => {
      const first = bodyOf(await call('mocco_status_incidents_search', { status: 'all', limit: 2 }));
      const second = bodyOf(
        await call('mocco_status_incidents_search', { status: 'all', limit: 2, before: first.nextBefore }),
      );

      expect((first.incidents as Row[]).map(incident => incident.id)).toEqual([slowDashboard, elevatedErrors]);
      expect(first.nextBefore).toEqual(expect.any(String));
      expect((second.incidents as Row[]).map(incident => incident.id)).toEqual([loginOutage]);
      expect(second).not.toHaveProperty('nextBefore');
    });

    it('reads every page of the project unless one is named', async () => {
      const partner = await status.statusPages.createPage(mine, ada, { slug: slug(), title: 'Partner status' });
      const partnerIncident = await open(minutes(50), {
        pageId: partner.id,
        title: 'Partner API slow',
        severity: IncidentSeverities.minor,
        status: IncidentStatuses.investigating,
        body: 'Slow',
        components: [],
      });

      const every = bodyOf(await call('mocco_status_incidents_search', {}));
      const one = bodyOf(await call('mocco_status_incidents_search', { pageId: partner.id }));

      expect((every.incidents as Row[]).map(incident => incident.id)).toEqual([
        partnerIncident.id,
        slowDashboard,
        elevatedErrors,
      ]);
      expect((one.incidents as Row[]).map(incident => incident.id)).toEqual([partnerIncident.id]);
    });

    it("refuses another workspace's page exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const foreign = await call('mocco_status_incidents_search', { pageId: theirPage });
      const missing = await call('mocco_status_incidents_search', { pageId: nowhere });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('was not found');
      expect(textOf(foreign).replace(theirPage, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(foreign)).not.toContain('Their secret incident');
    });
  });

  describe('mocco_status_incidents_get', () => {
    it('reads the whole timeline and says whether there is a postmortem', async () => {
      const body = bodyOf(await call('mocco_status_incidents_get', { incidentId: loginOutage }));

      expect(body.incident).toEqual({
        id: loginOutage,
        title: 'Login outage',
        status: IncidentStatuses.resolved,
        severity: IncidentSeverities.critical,
        startedAt: T0.toISOString(),
        identifiedAt: null,
        resolvedAt: minutes(1).toISOString(),
        hasPostmortem: true,
      });
      expect(body.page).toMatchObject({ id: pageId, title: 'Acme status' });
      expect(body.updates).toEqual([
        { status: IncidentStatuses.investigating, body: 'Sign-ins fail', createdAt: expect.any(String) },
        { status: IncidentStatuses.resolved, body: 'Sign-ins work again', createdAt: expect.any(String) },
      ]);
      expect(body.affectedComponents).toEqual([]);
    });

    it('adds the postmortem, the authors and what each affected component shows when asked', async () => {
      const resolved = bodyOf(
        await call('mocco_status_incidents_get', { incidentId: loginOutage, responseFormat: 'detailed' }),
      );
      const ongoing = bodyOf(
        await call('mocco_status_incidents_get', { incidentId: elevatedErrors, responseFormat: 'detailed' }),
      );

      expect(resolved.incident).toMatchObject({ postmortem: 'An expired certificate.', createdByUserId: ada });
      expect((resolved.updates as Row[])[0]).toMatchObject({ id: expect.any(String), authorUserId: ada });
      expect(ongoing.affectedComponents).toEqual([
        {
          componentId: api,
          name: 'API',
          impact: ComponentStatuses.partialOutage,
          status: ComponentStatuses.partialOutage,
        },
      ]);
    });

    it("adds the deploys linked to it, Mocco's suggestion and a person's link, only when asked", async () => {
      const repoId = await seedRepo(t.db, mine.workspaceId, 'api', [mine.projectId]);
      const suspect = await seedRelease(t.db, {
        workspaceId: mine.workspaceId,
        repoId,
        projectIds: [mine.projectId],
        releasedAt: minutes(5),
      });
      const { runId: fix, sha: fixSha } = await seedRun(t.db, {
        workspaceId: mine.workspaceId,
        repoId,
        finishedAt: minutes(16),
      });
      await status.statusCorrelation.correlate(mine, elevatedErrors);
      await status.statusCorrelation.link(mine, ada, { incidentId: elevatedErrors, runId: fix, relation: 'fix' });

      const concise = bodyOf(await call('mocco_status_incidents_get', { incidentId: elevatedErrors }));
      const detailed = bodyOf(
        await call('mocco_status_incidents_get', { incidentId: elevatedErrors, responseFormat: 'detailed' }),
      );

      expect(concise).not.toHaveProperty('deploys');
      const deploys = detailed.deploys as Row[];
      expect(deploys).toHaveLength(2);
      expect(deploys).toContainEqual({
        runId: suspect,
        relation: IncidentRunRelations.suspected,
        score: expect.any(Number),
        linkedBy: 'mocco',
        linkedByUserId: null,
        linkedAt: expect.any(String),
        run: {
          state: RunStates.succeeded,
          repo: 'acme/api',
          commitSha: expect.any(String),
          finishedAt: minutes(5).toISOString(),
        },
      });
      expect(deploys).toContainEqual(
        expect.objectContaining({
          runId: fix,
          relation: IncidentRunRelations.fix,
          score: null,
          linkedBy: 'person',
          linkedByUserId: ada,
          run: expect.objectContaining({ commitSha: fixSha, finishedAt: minutes(16).toISOString() }),
        }),
      );
    });

    it("refuses another workspace's incident exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const foreign = await call('mocco_status_incidents_get', { incidentId: theirIncident });
      const missing = await call('mocco_status_incidents_get', { incidentId: nowhere });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('was not found');
      expect(textOf(foreign).replace(theirIncident, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(foreign)).not.toContain('Their secret incident');
    });
  });

  describe('mocco_status_maintenances_search', () => {
    it('finds windows scheduled or in progress unless asked for more', async () => {
      const upcoming = bodyOf(await call('mocco_status_maintenances_search', {}));
      const every = bodyOf(await call('mocco_status_maintenances_search', { status: 'all' }));
      const canceledOnly = bodyOf(await call('mocco_status_maintenances_search', { status: 'canceled' }));

      expect(upcoming.maintenances).toEqual([
        {
          id: running,
          pageId,
          title: 'Database upgrade',
          status: 'in_progress',
          scheduledStart: minutes(20).toISOString(),
          scheduledEnd: minutes(200).toISOString(),
        },
      ]);
      expect((every.maintenances as Row[]).map(window => window.id)).toEqual([canceled, running]);
      expect((canceledOnly.maintenances as Row[]).map(window => window.id)).toEqual([canceled]);
    });

    it('adds when it really started and the components it covers when asked', async () => {
      const body = bodyOf(await call('mocco_status_maintenances_search', { responseFormat: 'detailed' }));

      expect(body.maintenances).toEqual([
        expect.objectContaining({
          body: 'Read-only for a while',
          actualStart: minutes(30).toISOString(),
          actualEnd: null,
          components: [{ componentId: dashboard, name: 'Dashboard' }],
        }),
      ]);
    });

    it('pages latest start first', async () => {
      const first = bodyOf(await call('mocco_status_maintenances_search', { status: 'all', limit: 1 }));
      const second = bodyOf(
        await call('mocco_status_maintenances_search', { status: 'all', limit: 1, before: first.nextBefore }),
      );

      expect((first.maintenances as Row[]).map(window => window.id)).toEqual([canceled]);
      expect((second.maintenances as Row[]).map(window => window.id)).toEqual([running]);
      expect(second).not.toHaveProperty('nextBefore');
    });
  });

  it('refuses a workspace the caller is not in exactly as one that does not exist', async () => {
    const nowhere = randomUUID();

    const existing = await call('mocco_status_incidents_search', {
      workspaceId: theirs.workspaceId,
      projectId: theirs.projectId,
    });
    const missing = await call('mocco_status_incidents_search', { workspaceId: nowhere, projectId: randomUUID() });

    expect(existing.result?.isError).toBe(true);
    expect(textOf(existing)).toContain('No workspace');
    expect(textOf(existing).replace(theirs.workspaceId, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
    expect(textOf(existing)).not.toContain('Their secret incident');
  });

  it("refuses another workspace's project exactly as one that does not exist", async () => {
    const nowhere = randomUUID();

    const foreign = await call('mocco_status_pages_get', { projectId: theirs.projectId });
    const missing = await call('mocco_status_pages_get', { projectId: nowhere });

    expect(foreign.result?.isError).toBe(true);
    expect(textOf(foreign)).toContain('was not found');
    expect(textOf(foreign).replace(theirs.projectId, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
  });

  it('refuses where the status product is off, as the console does', async () => {
    await project.products.disable(mine.workspaceId, Products.status);

    const answers = await Promise.all(
      STATUS_TOOLS.map(
        async tool => await call(tool, tool === 'mocco_status_incidents_get' ? { incidentId: elevatedErrors } : {}),
      ),
    );

    expect(answers.map(answer => answer.result?.isError)).toEqual([true, true, true, true]);
    expect(answers.every(answer => textOf(answer).includes('not enabled'))).toBe(true);
  });
});
