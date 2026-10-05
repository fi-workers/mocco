// `mocco_status_monitors_*` and `mocco_status_locations_search` over a real database,
// through the real HTTP handler.
//
// A monitor's spec can carry secrets (a URL's credentials and query, a request body) and a
// location has a token hash, so besides what a caller cannot see (another workspace's
// monitors and locations, a workspace without the status product), these tests check that
// none of that ever reaches an answer.
import { randomUUID } from 'node:crypto';

import { Products } from '@mocco/common/project';
import {
  CheckOutcomes,
  ComponentImpacts,
  IncidentPolicies,
  IncidentStatuses,
  IncidentVisibilities,
  LocationKinds,
  MonitorKinds,
  MonitorStates,
  monitorInputSchema,
} from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { generateLocationToken, hashLocationToken } from '@backend/domain/status/location-token';
import { LocationRepo } from '@backend/domain/status/repos/location.repo';
import { TimeSeriesRetention } from '@backend/domain/status/TimeSeriesRetention';
import { expectOne } from '@backend/infra/db/rows';
import { members, statusLocations, statusMonitors, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { ProjectDomain } from '@backend/domain/project/instance';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { ProbeLocation } from '@backend/domain/status/ProbeService';
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
  throw new Error('the status monitor tools must not reach another domain');
};

interface RpcAnswer {
  result?: { isError?: boolean; content?: { type: string; text: string }[] };
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

/** What the API monitor's spec carries that must never reach an answer. */
const SECRETS = ['s3cret-pass', 'q-secret-token', 'hunter2-body', 'kw-secret', '/health'];

/** The ids in an answer's list, in its order. */
const ids = (body: Record<string, unknown>, key = 'monitors') => (body[key] as Row[]).map(row => row.id);

const MONITOR_TOOLS = ['mocco_status_monitors_search', 'mocco_status_monitors_get', 'mocco_status_locations_search'];

describe('mocco_status_monitors_* and mocco_status_locations_search (pglite, over HTTP)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let project: ProjectDomain;
  let handler: McpHttpHandler;
  let clock: Date;
  let ada: string;
  let mine: StatusScope;
  let theirs: StatusScope;
  let fra: ProbeLocation;
  let office: string;
  let officeToken: string;
  let theirOffice: string;
  let apiComponent: string;
  let apiHealth: string;
  let database: string;
  let marketing: string;
  let theirMonitor: string;

  async function call(tool: string, args: Record<string, unknown>, userId = ada): Promise<RpcAnswer> {
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': tool,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: args, _meta: envelope },
      }),
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

  async function addWorkspace(memberId?: string): Promise<StatusScope> {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    if (memberId !== undefined) {
      await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'member' });
    }
    await project.products.enable(workspaceId, Products.status, ada);
    const created = await project.projects.create(workspaceId, { name: 'Shop', handle: 'shop' });
    return { workspaceId, projectId: created.id };
  }

  const monitor = async (scope: StatusScope, input: Record<string, unknown>) =>
    await status.statusMonitors.create(scope, ada, monitorInputSchema.parse(input));

  /** Move the clock past the API monitor's next round and have fra report a failure. */
  async function failingRound() {
    const due = expectOne(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, apiHealth)));
    clock = new Date(due.nextRoundAt.getTime() + 1000);
    const { leases } = await status.statusProbes.lease(fra, { agentVersion: '1.2.3', capacity: 10 });
    await status.statusProbes.report(
      fra,
      leases.map(lease => ({
        leaseId: lease.leaseId,
        monitorId: lease.monitorId,
        roundAt: lease.roundAt,
        outcome: CheckOutcomes.fail,
        latencyMs: 100,
      })),
    );
  }

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    status = createStatusDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), now: () => clock });
    project = createProjectDomain(t.db);
    await new TimeSeriesRetention({ db: t.db }).run(T0);
    ada = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    // A plain member: reading monitors and locations needs no admin role, as in the console.
    mine = await addWorkspace(ada);
    theirs = await addWorkspace();

    // A hosted region every workspace sees, a private location of each workspace.
    const fraToken = generateLocationToken();
    await new LocationRepo(t.db).insert({
      workspaceId: null,
      code: 'fra',
      name: 'Frankfurt',
      kind: LocationKinds.hosted,
      tokenHash: hashLocationToken(fraToken),
    });
    const authenticated = await status.statusProbes.authenticate(fraToken);
    if (authenticated === undefined) {
      throw new Error('fixture location did not authenticate');
    }
    fra = authenticated;
    ({
      location: { id: office },
      token: officeToken,
    } = await status.statusLocations.create(mine.workspaceId, ada, { code: 'office', name: 'Office' }));
    ({
      location: { id: theirOffice },
    } = await status.statusLocations.create(theirs.workspaceId, ada, { code: 'their-office', name: 'Their office' }));

    const page = await status.statusPages.createPage(mine, ada, {
      slug: `s${randomUUID().slice(0, 8)}`,
      title: 'Acme',
    });
    ({ id: apiComponent } = await status.statusPages.createComponent(mine, page.id, { name: 'API' }));

    // An HTTP check whose URL and body carry secrets, going down at fra; a TCP check at the
    // office that has not run yet; and a paused one.
    ({ id: apiHealth } = await monitor(mine, {
      name: 'API health',
      spec: {
        kind: MonitorKinds.http,
        url: 'https://probe:s3cret-pass@api.acme.test:8443/health?token=q-secret-token',
        method: 'POST',
        body: 'password=hunter2-body',
        keyword: 'kw-secret',
        latencyThresholdMs: 500,
      },
      locationIds: [fra.id],
      components: [{ componentId: apiComponent, impactWhenDown: ComponentImpacts.majorOutage }],
      incidentPolicy: IncidentPolicies.draft,
    }));
    ({ id: database } = await monitor(mine, {
      name: 'Database',
      spec: { kind: MonitorKinds.tcp, host: 'db.acme.internal', port: 5432 },
      locationIds: [office],
      intervalSeconds: 300,
    }));
    ({ id: marketing } = await monitor(mine, {
      name: 'Marketing site',
      spec: { kind: MonitorKinds.http, url: 'https://www.acme.test/' },
      locationIds: [fra.id],
    }));
    await status.statusMonitors.pause(mine, ada, marketing);
    ({ id: theirMonitor } = await monitor(theirs, {
      name: 'Their secret monitor',
      spec: { kind: MonitorKinds.http, url: 'https://their.test/' },
      locationIds: [theirOffice],
    }));

    // Two failing rounds: suspect, then down, which opens a draft incident.
    await failingRound();
    await failingRound();

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
      statusIncidents: { list: refuse, get: refuse },
      statusMaintenances: { list: refuse },
      statusMonitors: status.statusMonitors,
      statusLocations: status.statusLocations,
      statusCorrelation: { list: refuse },
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

  describe('mocco_status_monitors_search', () => {
    it("lists the project's monitors by name with their target, state and components, concise unless asked", async () => {
      const body = bodyOf(await call('mocco_status_monitors_search', {}));
      const monitors = body.monitors as Row[];

      expect(monitors.map(each => each.name)).toEqual(['API health', 'Database', 'Marketing site']);
      expect(monitors[0]).toEqual({
        id: apiHealth,
        name: 'API health',
        kind: MonitorKinds.http,
        target: 'api.acme.test:8443',
        state: MonitorStates.down,
        stateChangedAt: expect.any(String),
        components: [{ componentId: apiComponent, name: 'API', impactWhenDown: ComponentImpacts.majorOutage }],
      });
      expect(monitors[1]).toMatchObject({ target: 'db.acme.internal:5432', state: MonitorStates.pending });
      expect(monitors[2]).toMatchObject({ state: MonitorStates.paused });
      expect(body).not.toHaveProperty('nextAfter');
    });

    it('adds the settings and the locations when asked', async () => {
      const body = bodyOf(await call('mocco_status_monitors_search', { responseFormat: 'detailed' }));
      const [api, db] = body.monitors as Row[];

      expect(api).toMatchObject({
        method: 'POST',
        timeoutMs: 10_000,
        latencyThresholdMs: 500,
        intervalSeconds: 60,
        confirmations: 2,
        recoveryConfirmations: 2,
        quorumMode: 'majority',
        incidentPolicy: IncidentPolicies.draft,
        locations: [{ id: fra.id, code: 'fra', name: 'Frankfurt' }],
      });
      expect(db).toMatchObject({ intervalSeconds: 300, locations: [{ id: office, code: 'office', name: 'Office' }] });
      expect(db).not.toHaveProperty('method');
    });

    it('filters by state and name', async () => {
      expect(ids(bodyOf(await call('mocco_status_monitors_search', { states: ['down'] })))).toEqual([apiHealth]);
      expect(ids(bodyOf(await call('mocco_status_monitors_search', { states: ['paused', 'pending'] })))).toEqual([
        database,
        marketing,
      ]);
      expect(ids(bodyOf(await call('mocco_status_monitors_search', { states: ['up'] })))).toEqual([]);
      expect(ids(bodyOf(await call('mocco_status_monitors_search', { query: 'DATA' })))).toEqual([database]);
    });

    it('pages by name, and says where the next page starts only when there is one', async () => {
      const first = bodyOf(await call('mocco_status_monitors_search', { limit: 2 }));
      const second = bodyOf(await call('mocco_status_monitors_search', { limit: 2, after: first.nextAfter }));

      expect(ids(first)).toEqual([apiHealth, database]);
      expect(first.nextAfter).toEqual(expect.any(String));
      expect(ids(second)).toEqual([marketing]);
      expect(second).not.toHaveProperty('nextAfter');
    });
  });

  describe('mocco_status_monitors_get', () => {
    it('reads the state changes newest first and the incident the monitor opened', async () => {
      const body = bodyOf(await call('mocco_status_monitors_get', { monitorId: apiHealth }));

      expect(body.monitor).toMatchObject({ id: apiHealth, state: MonitorStates.down, target: 'api.acme.test:8443' });
      expect(body.stateChanges).toEqual([
        { from: MonitorStates.suspect, to: MonitorStates.down, at: expect.any(String) },
        { from: MonitorStates.pending, to: MonitorStates.suspect, at: expect.any(String) },
      ]);
      expect(body.openIncident).toEqual({
        id: expect.any(String),
        pageId: expect.any(String),
        title: 'API health is down',
        status: IncidentStatuses.investigating,
        severity: expect.any(String),
        visibility: IncidentVisibilities.draft,
        startedAt: expect.any(String),
      });
      expect(body).not.toHaveProperty('recentRounds');
    });

    it('adds why each state changed and the latest closed rounds when asked, and caps the changes', async () => {
      const body = bodyOf(
        await call('mocco_status_monitors_get', { monitorId: apiHealth, responseFormat: 'detailed', limit: 1 }),
      );
      const paused = bodyOf(
        await call('mocco_status_monitors_get', { monitorId: marketing, responseFormat: 'detailed' }),
      );

      expect(body.stateChanges).toEqual([
        {
          from: MonitorStates.suspect,
          to: MonitorStates.down,
          at: expect.any(String),
          roundAt: expect.any(String),
          reason: { by: 'evaluator', verdict: 'fail', okCount: 0, failCount: 1, noDataCount: 0 },
        },
      ]);
      const rounds = body.recentRounds as Row[];
      expect(rounds.map(round => round.verdict)).toEqual(['fail', 'fail']);
      expect(String(rounds[0]?.roundAt) > String(rounds[1]?.roundAt)).toBe(true);
      expect(body.monitor).toMatchObject({ incidentPolicy: IncidentPolicies.draft });
      expect(paused.openIncident).toBeNull();
      expect(paused.stateChanges).toEqual([
        expect.objectContaining({ to: MonitorStates.paused, reason: { by: 'operator', userId: ada } }),
      ]);
    });

    it("refuses another workspace's monitor exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const foreign = await call('mocco_status_monitors_get', { monitorId: theirMonitor });
      const missing = await call('mocco_status_monitors_get', { monitorId: nowhere });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('was not found');
      expect(textOf(foreign).replace(theirMonitor, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(foreign)).not.toContain('Their secret monitor');
    });
  });

  describe('mocco_status_locations_search', () => {
    it("lists the hosted regions and the workspace's own, never another's", async () => {
      const body = bodyOf(await call('mocco_status_locations_search', {}));

      expect(body.locations).toEqual([
        {
          id: fra.id,
          code: 'fra',
          name: 'Frankfurt',
          kind: LocationKinds.hosted,
          lastSeenAt: expect.any(String),
          agentVersion: '1.2.3',
          isDisabled: false,
        },
        {
          id: office,
          code: 'office',
          name: 'Office',
          kind: LocationKinds.private,
          lastSeenAt: null,
          agentVersion: null,
          isDisabled: false,
        },
      ]);
    });

    it('filters by kind, pages, and adds when it was disabled when asked', async () => {
      await status.statusLocations.disable(mine.workspaceId, ada, office);

      const own = bodyOf(await call('mocco_status_locations_search', { kind: 'private', responseFormat: 'detailed' }));
      const first = bodyOf(await call('mocco_status_locations_search', { limit: 1 }));
      const second = bodyOf(await call('mocco_status_locations_search', { limit: 1, after: first.nextAfter }));

      expect(own.locations).toEqual([
        expect.objectContaining({ id: office, isDisabled: true, disabledAt: expect.any(String) }),
      ]);
      expect(ids(first, 'locations')).toEqual([fra.id]);
      expect(ids(second, 'locations')).toEqual([office]);
      expect(second).not.toHaveProperty('nextAfter');
    });

    it('refuses a workspace the caller is not in exactly as one that does not exist', async () => {
      const nowhere = randomUUID();

      const existing = await call('mocco_status_locations_search', { workspaceId: theirs.workspaceId });
      const missing = await call('mocco_status_locations_search', { workspaceId: nowhere });

      expect(existing.result?.isError).toBe(true);
      expect(textOf(existing)).toContain('No workspace');
      expect(textOf(existing).replace(theirs.workspaceId, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(existing)).not.toContain('their-office');
    });
  });

  it('never answers with a secret of the spec, a request header or a token hash', async () => {
    const rows = await t.db.select({ tokenHash: statusLocations.tokenHash }).from(statusLocations);
    const hashes = rows.map(row => row.tokenHash);
    const answers = await Promise.all([
      call('mocco_status_monitors_search', { responseFormat: 'detailed' }),
      call('mocco_status_monitors_get', { monitorId: apiHealth, responseFormat: 'detailed' }),
      call('mocco_status_locations_search', { responseFormat: 'detailed' }),
    ]);
    const texts = answers.map(answer => {
      expect(answer.result?.isError, textOf(answer)).not.toBe(true);
      return textOf(answer);
    });

    const forbidden = [...SECRETS, ...hashes, officeToken, 'tokenHash', 'headers', 'probe:'];
    const answered = texts.join('\n');
    const leaks = forbidden.filter(secret => answered.includes(secret));
    expect(leaks).toEqual([]);
  });

  it("refuses another workspace's project exactly as one that does not exist", async () => {
    const nowhere = randomUUID();

    const foreign = await call('mocco_status_monitors_search', { projectId: theirs.projectId });
    const missing = await call('mocco_status_monitors_search', { projectId: nowhere });

    expect(foreign.result?.isError).toBe(true);
    expect(textOf(foreign)).toContain('was not found');
    expect(textOf(foreign).replace(theirs.projectId, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
  });

  it('refuses where the status product is off, as the console does', async () => {
    await project.products.disable(mine.workspaceId, Products.status);

    const answers = await Promise.all(
      MONITOR_TOOLS.map(
        async tool => await call(tool, tool === 'mocco_status_monitors_get' ? { monitorId: apiHealth } : {}),
      ),
    );

    expect(answers.map(answer => answer.result?.isError)).toEqual([true, true, true]);
    expect(answers.every(answer => textOf(answer).includes('not enabled'))).toBe(true);
  });
});
