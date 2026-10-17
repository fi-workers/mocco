// The status page changes over MCP (`status-incidents.ts`, `status-maintenance.ts`,
// `status-pages.ts`) over a real database, through the real HTTP handler.
//
// These change what a team says to its customers, so besides what every changing tool proves
// (`status:write` stepped up for, the workspace's opt-in, a confirmation that names the change,
// nothing changed until the person says yes, another tenant's ids read like missing ones), these
// tests check that a confirmation shows exactly what will be published and says it is public, and
// that an answer given after the state it showed has changed is refused rather than applied.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { Products } from '@mocco/common/project';
import {
  ComponentImpacts,
  ComponentStatuses,
  IncidentRunRelations,
  IncidentSeverities,
  IncidentStatuses,
  IncidentVisibilities,
  MaintenanceStatuses,
} from '@mocco/common/status';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { seedRelease, seedRepo, seedRun } from '@backend/domain/status/testing/deploys';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  members,
  statusComponents,
  statusIncidents,
  statusIncidentUpdates,
  statusMaintenances,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';
import { StatusIncidentTools } from '@backend/transport/mcp/tools/status-incidents';
import { StatusMaintenanceTools } from '@backend/transport/mcp/tools/status-maintenance';
import { StatusPageTools } from '@backend/transport/mcp/tools/status-pages';

import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { ProjectDomain } from '@backend/domain/project/instance';
import type { StatusDomain } from '@backend/domain/status/compose';
import type { StatusScope } from '@backend/domain/status/scope';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the status change tools must not reach another domain');
};

interface RpcAnswer {
  status?: number;
  wwwAuthenticate?: string;
  result?: {
    resultType?: string;
    isError?: boolean;
    content?: { type: string; text: string }[];
    inputRequests?: Record<string, { method: string; params: { message: string } }>;
    requestState?: string;
  };
}

interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });
const messageOf = (answer: RpcAnswer) => answer.result?.inputRequests?.confirm?.params.message ?? '';
const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

const SIGN_IN = ['openid', 'profile', 'email', 'offline_access'];
const WITH_STATUS_WRITE = [...SIGN_IN, 'status:write'];

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  expect(answer.result?.resultType, textOf(answer)).not.toBe('input_required');
  return JSON.parse(textOf(answer)) as Row;
}

const T0 = new Date('2026-10-05T09:00:00.000Z');

/** Ascending by code unit. */
const byText = (a: unknown, b: unknown) => String(a).localeCompare(String(b));
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

describe('status page changes over MCP (pglite, over HTTP)', () => {
  let t: TestDb;
  let status: StatusDomain;
  let project: ProjectDomain;
  let handler: McpHttpHandler;
  let settings: McpSettingsService;
  let clock: Date;
  let ada: string;
  let grace: string;
  let mine: StatusScope;
  let theirs: StatusScope;
  let pageId: string;
  let api: string;
  let web: string;
  let otherPageComponent: string;
  let outage: string;
  let theirIncident: string;
  let window: string;

  async function call(
    tool: string,
    args: Record<string, unknown>,
    scopes = WITH_STATUS_WRITE,
    round: Round = {},
    userId = ada,
  ): Promise<RpcAnswer> {
    const response = await handler.fetch(
      new Request(RESOURCE, {
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
          params: { name: tool, arguments: args, _meta: envelope, ...round },
        }),
      }),
      {
        authInfo: {
          token: '',
          clientId: 'agent',
          scopes,
          resource: new URL(RESOURCE),
          extra: { [MCP_USER_ID]: userId },
        },
      },
    );
    const text = await response.text();
    return {
      status: response.status,
      wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
      ...((text === '' ? {} : JSON.parse(text)) as RpcAnswer),
    };
  }

  /** The first call, which must ask; returns the question and the state to echo. */
  async function ask(tool: string, args: Record<string, unknown>) {
    const asked = await call(tool, args);
    expect(asked.result?.resultType, textOf(asked)).toBe('input_required');
    return { question: messageOf(asked), requestState: asked.result?.requestState ?? '' };
  }

  const answer = async (tool: string, args: Record<string, unknown>, requestState: string, isConfirmed = true) =>
    await call(tool, args, WITH_STATUS_WRITE, { requestState, inputResponses: accepting(isConfirmed) });

  /** Ask, then answer: the whole round trip. */
  async function confirmed(tool: string, args: Record<string, unknown>, isConfirmed = true) {
    const { requestState } = await ask(tool, args);
    return await answer(tool, args, requestState, isConfirmed);
  }

  const incidentsOnPage = async () =>
    await t.db.select().from(statusIncidents).where(eq(statusIncidents.pageId, pageId));
  const updatesOf = async (incidentId: string) =>
    await t.db.select().from(statusIncidentUpdates).where(eq(statusIncidentUpdates.incidentId, incidentId));
  const incidentRow = async (incidentId: string) =>
    expectOne(await t.db.select().from(statusIncidents).where(eq(statusIncidents.id, incidentId)));
  const windowRow = async (id: string) =>
    expectOne(await t.db.select().from(statusMaintenances).where(eq(statusMaintenances.id, id)));
  const componentRow = async (id: string) =>
    expectOne(await t.db.select().from(statusComponents).where(eq(statusComponents.id, id)));

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

  const person = async (name: string) =>
    expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name, email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;

  beforeEach(async () => {
    t = await createTestDb();
    clock = T0;
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    status = createStatusDomain(t.db, { audit, now: () => clock });
    project = createProjectDomain(t.db);
    ada = await person('Ada');
    grace = await person('Grace');
    // A plain member: changing a status page needs no admin role, as in the console.
    mine = await addWorkspace(ada);
    await t.db.insert(members).values({ organizationId: mine.workspaceId, userId: grace, role: 'member' });
    theirs = await addWorkspace();

    ({ id: pageId } = await status.statusPages.createPage(mine, ada, { slug: 'acme-status', title: 'Acme' }));
    ({ id: api } = await status.statusPages.createComponent(mine, pageId, { name: 'API' }));
    ({ id: web } = await status.statusPages.createComponent(mine, pageId, { name: 'Web' }));
    // A second page of the project, whose component the first page's incidents can't affect.
    const second = await status.statusPages.createPage(mine, ada, { slug: 'acme-internal', title: 'Internal' });
    ({ id: otherPageComponent } = await status.statusPages.createComponent(mine, second.id, { name: 'Queue' }));
    ({ id: outage } = await status.statusIncidents.create(mine, ada, {
      pageId,
      title: 'Elevated errors',
      severity: IncidentSeverities.major,
      status: IncidentStatuses.investigating,
      body: 'We are looking into it.',
      components: [{ componentId: api, impact: ComponentImpacts.partialOutage }],
    }));
    const theirPage = await status.statusPages.createPage(theirs, ada, { slug: 'their-status', title: 'Theirs' });
    ({ id: theirIncident } = await status.statusIncidents.create(theirs, ada, {
      pageId: theirPage.id,
      title: 'Their secret incident',
      severity: IncidentSeverities.minor,
      status: IncidentStatuses.investigating,
      body: 'Theirs.',
      components: [],
    }));
    ({ id: window } = await status.statusMaintenances.schedule(mine, ada, {
      pageId,
      title: 'Database upgrade',
      body: '',
      scheduledStart: minutes(60),
      scheduledEnd: minutes(120),
      componentIds: [api],
    }));

    settings = createMcpSettingsService(t.db, audit);
    await settings.setAgentsMayDecide(mine.workspaceId, true, ada);

    const scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    handler = createMcpHttpHandler({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals: { listLabeled: refuse, get: refuse, vote: refuse },
      gates: { getPending: refuse, resume: refuse },
      flags: { listFlags: refuse, listEnvironments: refuse, history: refuse },
      otaHosting: { listApps: refuse, requireApp: refuse, listChannels: refuse },
      otaChannels: { listHeads: refuse },
      otaReleases: { listReleases: refuse },
      otaMetrics: { channelReach: refuse, monthlyActiveDevices: refuse },
      versionPolicies: { get: refuse, listChanges: refuse },
      projectApps: { listApps: refuse },
      statusPages: { listPages: refuse, getPage: refuse },
      statusIncidents: { list: refuse, get: refuse },
      statusMaintenances: { list: refuse },
      statusMonitors: { list: refuse, get: refuse, find: refuse, requestCheck: refuse },
      statusLocations: { list: refuse },
      statusCorrelation: { list: refuse },
      statusChanges: {
        pages: status.statusPages,
        incidents: status.statusIncidents,
        correlation: status.statusCorrelation,
        maintenances: status.statusMaintenances,
        monitors: status.statusMonitors,
        locations: status.statusLocations,
      },
      helpPublic: { searchInProject: refuse, siteInProject: refuse, articleInProject: refuse },
      helpFeedback: { helpfulness: refuse },
      helpTranslations: { grid: refuse, reviewByShortId: refuse },
      helpGlossary: { list: refuse },
      messengerInbox: { list: refuse, get: refuse, write: refuse, assign: refuse, assignable: refuse },
      feedbackBoards: { listBoards: refuse, getBoard: refuse },
      feedbackPosts: { list: refuse, get: refuse, requirePost: refuse, setStatus: refuse },
      feedbackVotes: { list: refuse, find: refuse, vote: refuse },
      feedbackComments: { listForStaff: refuse, createAsStaff: refuse },
      feedbackMerges: { merge: refuse },
      scope,
      projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
      settings,
      confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const newIncident = () => ({
    pageId,
    title: 'Checkout is down',
    severity: IncidentSeverities.critical,
    status: IncidentStatuses.identified,
    body: 'Payments fail at **checkout**. A fix is rolling out.',
    components: [{ componentId: web, impact: ComponentImpacts.majorOutage }],
  });

  const upgrade = () => ({
    pageId,
    title: 'Search reindex',
    body: 'Search may be slow.',
    scheduledStart: '2026-10-06T02:00:00Z',
    scheduledEnd: '2026-10-06T03:30:00+00:00',
    componentIds: [] as string[],
  });

  const everyChange = (): [string, Record<string, unknown>][] => [
    [StatusIncidentTools.create, { ...newIncident(), pageId }],
    [StatusIncidentTools.postUpdate, { incidentId: outage, body: 'x' }],
    [StatusIncidentTools.setComponents, { incidentId: outage, components: [] }],
    [StatusIncidentTools.setPostmortem, { incidentId: outage, postmortem: 'x' }],
    [StatusIncidentTools.linkRun, { incidentId: outage, runId: randomUUID() }],
    [StatusIncidentTools.unlinkRun, { incidentId: outage, runId: randomUUID() }],
    [StatusIncidentTools.correlate, { incidentId: outage }],
    [
      StatusMaintenanceTools.schedule,
      { pageId, title: 'x', scheduledStart: '2026-10-06T02:00:00Z', scheduledEnd: '2026-10-06T03:00:00Z' },
    ],
    [StatusMaintenanceTools.cancel, { maintenanceId: window }],
    [StatusPageTools.setComponentStatus, { componentId: api, status: ComponentStatuses.degraded }],
  ];

  const resolving = () => ({ incidentId: outage, status: IncidentStatuses.resolved, body: 'Fixed and verified.' });

  describe(StatusIncidentTools.create, () => {
    it('asks first, quoting exactly what will be published and saying it is public, and opens nothing until answered', async () => {
      const before = await incidentsOnPage();

      const { question } = await ask(StatusIncidentTools.create, newIncident());

      expect(question).toContain('"Acme" (address acme-status)');
      expect(question).toContain('PUBLIC');
      expect(question).toContain('subscribers are sent it');
      expect(question).toContain('Title: Checkout is down');
      expect(question).toContain('Severity: critical');
      expect(question).toContain('Status: identified');
      expect(question).toContain('Affects: Web (major_outage)');
      expect(question.endsWith('Payments fail at **checkout**. A fix is rolling out.')).toBe(true);
      expect(await incidentsOnPage()).toHaveLength(before.length);
    });

    it('opens a published incident as the person once confirmed, and the same answer twice opens one', async () => {
      const { requestState } = await ask(StatusIncidentTools.create, newIncident());

      const body = bodyOf(await answer(StatusIncidentTools.create, newIncident(), requestState));
      const replayed = await answer(StatusIncidentTools.create, newIncident(), requestState);

      const created = body.incident as Row;
      expect(body.created).toBe(true);
      expect(created).toMatchObject({
        title: 'Checkout is down',
        status: IncidentStatuses.identified,
        severity: IncidentSeverities.critical,
        visibility: IncidentVisibilities.published,
      });
      const row = await incidentRow(created.id as string);
      expect(row.createdByUserId).toBe(ada);
      expect(row.origin).toBe('manual');
      const updates = await updatesOf(row.id);
      expect(updates.map(update => update.bodyMd)).toEqual([newIncident().body]);
      expect(replayed.result?.isError).toBe(true);
      expect(textOf(replayed)).toContain('different change');
      expect(await incidentsOnPage()).toHaveLength(2);
      const audited = await t.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.subjectId, row.id), eq(auditLog.action, AuditActions.statusIncidentCreated)));
      expect(audited.map(entry => entry.actorUserId)).toEqual([ada]);
    });

    it('opens nothing when the person says no', async () => {
      const body = bodyOf(await confirmed(StatusIncidentTools.create, newIncident(), false));

      expect(body).toMatchObject({ changed: false });
      expect(await incidentsOnPage()).toHaveLength(1);
    });

    it('refuses a component of another page before asking anything', async () => {
      const answered = await call(StatusIncidentTools.create, {
        ...newIncident(),
        components: [{ componentId: otherPageComponent, impact: ComponentImpacts.degraded }],
        pageId,
      });

      expect(answered.result?.resultType).not.toBe('input_required');
      expect(answered.result?.isError).toBe(true);
      expect(textOf(answered)).toContain(`Status component ${otherPageComponent} was not found`);
    });

    it('asks which page when the project has more than one and none is named', async () => {
      const { title, severity, body } = newIncident();
      const answered = await call(StatusIncidentTools.create, { title, severity, body });

      expect(answered.result?.isError).toBe(true);
      expect(textOf(answered)).toContain('pageId');
    });
  });

  describe(StatusIncidentTools.postUpdate, () => {
    it('asks with the status now, its latest update and the move, quoting the update', async () => {
      const { question } = await ask(StatusIncidentTools.postUpdate, resolving());

      expect(question).toContain('"Elevated errors"');
      expect(question).toContain('PUBLIC');
      expect(question).toContain('Now: investigating; latest update');
      expect(question).toContain('"We are looking into it."');
      expect(question).toContain('Status: investigating → resolved');
      expect(question).toContain('Resolving closes the incident');
      expect(question.endsWith('Fixed and verified.')).toBe(true);
      expect(await updatesOf(outage)).toHaveLength(1);
    });

    it('posts the update and moves the incident once confirmed', async () => {
      const body = bodyOf(await confirmed(StatusIncidentTools.postUpdate, resolving()));

      expect(body).toMatchObject({ posted: true, incident: { id: outage, status: IncidentStatuses.resolved } });
      const row = await incidentRow(outage);
      expect(row.status).toBe(IncidentStatuses.resolved);
      expect(row.resolvedAt).not.toBeNull();
      const updates = await updatesOf(outage);
      expect(updates.map(update => [update.bodyMd, update.authorUserId])).toContainEqual(['Fixed and verified.', ada]);
    });

    it('keeps the status when none is asked for', async () => {
      const args = { incidentId: outage, body: 'Still looking.' };
      const { question } = await ask(StatusIncidentTools.postUpdate, args);

      expect(question).toContain('Status stays: investigating');
      bodyOf(await confirmed(StatusIncidentTools.postUpdate, args));
      const kept = await incidentRow(outage);
      expect(kept.status).toBe(IncidentStatuses.investigating);
      expect(await updatesOf(outage)).toHaveLength(2);
    });

    it('refuses an answer given after someone else posted, and posts nothing', async () => {
      const { requestState } = await ask(StatusIncidentTools.postUpdate, resolving());
      clock = minutes(1);
      await status.statusIncidents.postUpdate(mine, grace, outage, {
        status: IncidentStatuses.identified,
        body: 'Found it: a bad config.',
      });

      const late = await answer(StatusIncidentTools.postUpdate, resolving(), requestState);

      expect(late.result?.isError).toBe(true);
      expect(textOf(late)).toContain('different change');
      const moved = await incidentRow(outage);
      expect(moved.status).toBe(IncidentStatuses.identified);
      expect(await updatesOf(outage)).toHaveLength(2);
    });

    it('answering the same confirmation twice posts once', async () => {
      const { requestState } = await ask(StatusIncidentTools.postUpdate, { incidentId: outage, body: 'Update.' });

      bodyOf(await answer(StatusIncidentTools.postUpdate, { incidentId: outage, body: 'Update.' }, requestState));
      const again = await answer(StatusIncidentTools.postUpdate, { incidentId: outage, body: 'Update.' }, requestState);

      expect(again.result?.isError).toBe(true);
      expect(await updatesOf(outage)).toHaveLength(2);
    });

    it('refuses a move the lifecycle does not allow, and a resolved incident, before asking', async () => {
      await status.statusIncidents.postUpdate(mine, ada, outage, {
        status: IncidentStatuses.monitoring,
        body: 'Fix out.',
      });
      const backwards = await call(StatusIncidentTools.postUpdate, {
        incidentId: outage,
        status: IncidentStatuses.investigating,
        body: 'Hm.',
      });
      await status.statusIncidents.postUpdate(mine, ada, outage, { status: IncidentStatuses.resolved, body: 'Done.' });
      const closed = await call(StatusIncidentTools.postUpdate, { incidentId: outage, body: 'More.' });

      expect([backwards.result?.resultType, closed.result?.resultType]).not.toContain('input_required');
      expect(textOf(backwards)).toContain("can't go from monitoring to investigating");
      expect(textOf(backwards)).toContain('identified, resolved');
      expect(textOf(closed)).toContain('is resolved');
      expect(await updatesOf(outage)).toHaveLength(3);
    });

    it('says a draft stays in the console', async () => {
      await t.db
        .update(statusIncidents)
        .set({ visibility: IncidentVisibilities.draft })
        .where(eq(statusIncidents.id, outage));

      const { question } = await ask(StatusIncidentTools.postUpdate, resolving());

      expect(question).toContain('is a draft');
      expect(question).not.toContain('PUBLIC');
    });

    it("refuses another workspace's incident exactly as one that does not exist, and posts nothing", async () => {
      const nowhere = randomUUID();

      const foreign = await call(StatusIncidentTools.postUpdate, { incidentId: theirIncident, body: 'x' });
      const missing = await call(StatusIncidentTools.postUpdate, { incidentId: nowhere, body: 'x' });
      const throughTheirProject = await call(StatusIncidentTools.postUpdate, {
        incidentId: theirIncident,
        projectId: theirs.projectId,
        body: 'x',
      });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign).replace(theirIncident, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(throughTheirProject)).toContain('was not found');
      expect(await updatesOf(theirIncident)).toHaveLength(1);
    });
  });

  describe(StatusIncidentTools.setComponents, () => {
    it('shows the components now and after, and replaces them once confirmed', async () => {
      const args = {
        incidentId: outage,
        components: [
          { componentId: web, impact: ComponentImpacts.degraded },
          { componentId: api, impact: ComponentImpacts.majorOutage },
        ],
      };
      const { question } = await ask(StatusIncidentTools.setComponents, args);

      expect(question).toContain('Now: API (partial_outage)');
      expect(question).toContain('API (major_outage)');
      expect(question).toContain('Web (degraded)');
      expect(question).toContain('Subscribers are not sent anything');
      bodyOf(await confirmed(StatusIncidentTools.setComponents, args));
      const read = await status.statusIncidents.get(mine, outage);
      expect(read.components.map(each => [each.componentId, each.impact]).toSorted(byText)).toEqual(
        [
          [api, ComponentImpacts.majorOutage],
          [web, ComponentImpacts.degraded],
        ].toSorted(byText),
      );
    });

    it('answers without asking when they are exactly these already', async () => {
      const body = bodyOf(
        await call(StatusIncidentTools.setComponents, {
          incidentId: outage,
          components: [{ componentId: api, impact: ComponentImpacts.partialOutage }],
        }),
      );

      expect(body).toMatchObject({ changed: false });
    });
  });

  describe(StatusIncidentTools.setPostmortem, () => {
    it('sets the postmortem once confirmed, and refuses an answer after someone else edited it', async () => {
      const args = { incidentId: outage, postmortem: '# What happened\n\nA bad config.' };
      const asked = await ask(StatusIncidentTools.setPostmortem, args);
      expect(asked.question).toContain('not on the public page');
      expect(asked.question).toContain('Now: none');

      bodyOf(await answer(StatusIncidentTools.setPostmortem, args, asked.requestState));
      const withPostmortem = await incidentRow(outage);
      expect(withPostmortem.postmortemMd).toBe(args.postmortem);

      const stale = await ask(StatusIncidentTools.setPostmortem, { incidentId: outage, postmortem: null });
      await status.statusIncidents.setPostmortem(mine, grace, outage, 'Grace rewrote it.');
      const late = await answer(
        StatusIncidentTools.setPostmortem,
        { incidentId: outage, postmortem: null },
        stale.requestState,
      );

      expect(late.result?.isError).toBe(true);
      expect(textOf(late)).toContain('different change');
      const rewritten = await incidentRow(outage);
      expect(rewritten.postmortemMd).toBe('Grace rewrote it.');
    });
  });

  describe('deploys linked to an incident', () => {
    it('links a run as the fix, unlinks it, and recomputes the suggestions, each once confirmed', async () => {
      const repoId = await seedRepo(t.db, mine.workspaceId, 'api', [mine.projectId]);
      await seedRelease(t.db, {
        workspaceId: mine.workspaceId,
        repoId,
        projectIds: [mine.projectId],
        releasedAt: minutes(-5),
      });
      const { runId } = await seedRun(t.db, { workspaceId: mine.workspaceId, repoId, finishedAt: minutes(16) });

      const link = { incidentId: outage, runId, relation: IncidentRunRelations.fix };
      const { question } = await ask(StatusIncidentTools.linkRun, link);
      expect(question).toContain('as fix (the run that resolved it)');
      expect(question).toContain('It is not linked now.');
      bodyOf(await confirmed(StatusIncidentTools.linkRun, link));
      expect(bodyOf(await call(StatusIncidentTools.linkRun, link))).toMatchObject({ changed: false });

      const correlated = bodyOf(await confirmed(StatusIncidentTools.correlate, { incidentId: outage }));
      expect(correlated).toMatchObject({ changed: true, suggested: 1 });
      const runs = await status.statusCorrelation.list(mine, outage);
      expect(runs.map(each => each.relation).toSorted(byText)).toEqual(
        [IncidentRunRelations.fix, IncidentRunRelations.suspected].toSorted(byText),
      );

      const unlink = { incidentId: outage, runId };
      const unlinkAsked = await ask(StatusIncidentTools.unlinkRun, unlink);
      expect(unlinkAsked.question).toContain('linked as fix');
      bodyOf(await confirmed(StatusIncidentTools.unlinkRun, unlink));
      const linksAfter = await status.statusCorrelation.list(mine, outage);
      expect(linksAfter.map(each => each.runId)).not.toContain(runId);

      const listed = bodyOf(await call(StatusIncidentTools.runIncidents, { runId }));
      expect(listed).toEqual({ runId, incidents: [] });
    });

    it('refuses to unlink a run that is not linked, before asking', async () => {
      const answered = await call(StatusIncidentTools.unlinkRun, { incidentId: outage, runId: randomUUID() });

      expect(answered.result?.resultType).not.toBe('input_required');
      expect(textOf(answered)).toContain('run link');
    });

    it("lists a run's incidents, and refuses another workspace's run like a missing one", async () => {
      const repoId = await seedRepo(t.db, mine.workspaceId, 'api', [mine.projectId]);
      const { runId } = await seedRun(t.db, { workspaceId: mine.workspaceId, repoId, finishedAt: minutes(1) });
      await status.statusCorrelation.link(mine, ada, {
        incidentId: outage,
        runId,
        relation: IncidentRunRelations.manual,
      });
      const theirRepo = await seedRepo(t.db, theirs.workspaceId, 'their', [theirs.projectId]);
      const { runId: theirRun } = await seedRun(t.db, {
        workspaceId: theirs.workspaceId,
        repoId: theirRepo,
        finishedAt: minutes(1),
      });

      const listed = bodyOf(await call(StatusIncidentTools.runIncidents, { runId }, SIGN_IN));
      const foreign = await call(StatusIncidentTools.runIncidents, { runId: theirRun }, SIGN_IN);

      expect(listed.incidents).toEqual([
        expect.objectContaining({
          incidentId: outage,
          title: 'Elevated errors',
          relation: IncidentRunRelations.manual,
        }),
      ]);
      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).toContain('was not found');
    });
  });

  describe(StatusMaintenanceTools.schedule, () => {
    it('asks with the window exactly as it will be announced, then schedules it once, as the person', async () => {
      const args = { ...upgrade(), pageId, componentIds: [web] };
      const { question, requestState } = await ask(StatusMaintenanceTools.schedule, args);

      expect(question).toContain('PUBLIC');
      expect(question).toContain('From: 2026-10-06T02:00:00.000Z');
      expect(question).toContain('To: 2026-10-06T03:30:00.000Z');
      expect(question).toContain('Covers: Web');
      expect(question.endsWith('Search may be slow.')).toBe(true);
      const body = bodyOf(await answer(StatusMaintenanceTools.schedule, args, requestState));
      const replayed = await answer(StatusMaintenanceTools.schedule, args, requestState);

      const created = await windowRow((body.maintenance as Row).id as string);
      expect(created).toMatchObject({
        title: 'Search reindex',
        status: MaintenanceStatuses.scheduled,
        createdByUserId: ada,
      });
      expect(replayed.result?.isError).toBe(true);
      const windows = await status.statusMaintenances.list(mine, pageId);
      expect(windows.map(each => each.title).toSorted(byText)).toEqual(['Database upgrade', 'Search reindex']);
    });

    it('refuses a window that ends before it starts, before asking', async () => {
      const answered = await call(StatusMaintenanceTools.schedule, {
        ...upgrade(),
        pageId,
        scheduledEnd: '2026-10-06T01:00:00Z',
      });

      expect(answered.result?.resultType).not.toBe('input_required');
      expect(textOf(answered)).toContain('ends after it starts');
    });
  });

  describe(StatusMaintenanceTools.cancel, () => {
    it('cancels a scheduled window once confirmed, and refuses an answer given after it started', async () => {
      const { question } = await ask(StatusMaintenanceTools.cancel, { maintenanceId: window });
      expect(question).toContain('"Database upgrade"');
      expect(question).toContain('Now: scheduled');
      expect(question).toContain('It will not start.');

      const stale = await ask(StatusMaintenanceTools.cancel, { maintenanceId: window });
      clock = minutes(61);
      await status.statusMaintenances.tick(clock);
      const late = await answer(StatusMaintenanceTools.cancel, { maintenanceId: window }, stale.requestState);
      expect(late.result?.isError).toBe(true);
      const started = await windowRow(window);
      expect(started.status).toBe(MaintenanceStatuses.inProgress);

      const fresh = await ask(StatusMaintenanceTools.cancel, { maintenanceId: window });
      expect(fresh.question).toContain('it ends now');
      bodyOf(await answer(StatusMaintenanceTools.cancel, { maintenanceId: window }, fresh.requestState));
      const canceled = await windowRow(window);
      expect(canceled.status).toBe(MaintenanceStatuses.canceled);

      const again = await call(StatusMaintenanceTools.cancel, { maintenanceId: window });
      expect(again.result?.resultType).not.toBe('input_required');
      expect(textOf(again)).toContain('is canceled');
    });
  });

  describe(StatusPageTools.setComponentStatus, () => {
    it('shows the status set by hand and what the page shows, and sets it once confirmed', async () => {
      const args = { componentId: api, status: ComponentStatuses.degraded };
      const { question } = await ask(StatusPageTools.setComponentStatus, args);

      expect(question).toContain('Set by hand now: operational → degraded');
      expect(question).toContain('The page shows now: partial_outage');
      bodyOf(await confirmed(StatusPageTools.setComponentStatus, args));
      const degraded = await componentRow(api);
      expect(degraded.status).toBe(ComponentStatuses.degraded);
      expect(bodyOf(await call(StatusPageTools.setComponentStatus, args))).toMatchObject({ changed: false });
    });

    it('refuses an answer given after someone else set it', async () => {
      const args = { componentId: web, status: ComponentStatuses.majorOutage };
      const { requestState } = await ask(StatusPageTools.setComponentStatus, args);
      await status.statusPages.setComponentStatus(mine, grace, web, ComponentStatuses.maintenance);

      const late = await answer(StatusPageTools.setComponentStatus, args, requestState);

      expect(late.result?.isError).toBe(true);
      const webNow = await componentRow(web);
      expect(webNow.status).toBe(ComponentStatuses.maintenance);
    });
  });

  describe('the locks every status change has', () => {
    it('challenges a token without status:write for it, for every change', async () => {
      const answers = await Promise.all(
        everyChange().map(async ([tool, args]) => ({ tool, answered: await call(tool, args, SIGN_IN) })),
      );

      expect(answers.map(({ tool, answered }) => [tool, answered.status])).toEqual(
        everyChange().map(([tool]) => [tool, 403]),
      );
      expect(answers.map(({ answered }) => answered.wwwAuthenticate)).toEqual(
        everyChange().map(() => expect.stringContaining('scope="status:write openid profile email offline_access"')),
      );
    });

    it('refuses every change in a workspace that has not allowed agents to make changes, and changes nothing', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);

      const answers = await Promise.all(
        everyChange().map(async ([tool, args]) => ({ tool, answered: await call(tool, args) })),
      );

      expect(
        answers.map(({ tool, answered }) => [tool, answered.result?.isError, answered.result?.resultType]),
      ).toEqual(everyChange().map(([tool]) => [tool, true, 'complete']));
      expect(answers.map(({ answered }) => textOf(answered))).toEqual(
        everyChange().map(() => expect.stringContaining('Settings → Agents')),
      );
      expect(await updatesOf(outage)).toHaveLength(1);
      expect(await incidentsOnPage()).toHaveLength(1);
    });

    it('refuses where the status product is off, as the console does', async () => {
      await project.products.disable(mine.workspaceId, Products.status);

      const answered = await call(StatusIncidentTools.postUpdate, { incidentId: outage, body: 'x' });

      expect(answered.result?.isError).toBe(true);
      expect(textOf(answered)).toContain('not enabled');
    });

    it('lists every change as a change and the run read as a read', async () => {
      const response = await handler.fetch(
        new Request(RESOURCE, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': PROTOCOL_VERSION,
            'mcp-method': 'tools/list',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: envelope } }),
        }),
        {
          authInfo: {
            token: '',
            clientId: 'agent',
            scopes: SIGN_IN,
            resource: new URL(RESOURCE),
            extra: { [MCP_USER_ID]: ada },
          },
        },
      );
      const listed = (await response.json()) as {
        result: { tools: { name: string; annotations?: Record<string, boolean> }[] };
      };
      const annotationsOf = (name: string) => listed.result.tools.find(each => each.name === name)?.annotations;

      expect(everyChange().map(([tool]) => [tool, annotationsOf(tool)?.readOnlyHint])).toEqual(
        everyChange().map(([tool]) => [tool, false]),
      );
      expect(annotationsOf(StatusIncidentTools.runIncidents)?.readOnlyHint).toBe(true);
    });
  });
});
