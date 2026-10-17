// The status page configuration changes over MCP (`status-page-structure.ts`,
// `status-monitor-changes.ts`, `status-gate-maintenance.ts`) over a real database, through the real
// HTTP handler: pages, groups and components, monitors, and the gates that announce maintenance.
//
// Besides what every changing tool proves (`status:write`, the workspace's opt-in, a confirmation,
// nothing changed until yes, another tenant's ids read like missing ones), these check that a
// monitor's check (its URL's credentials, path and query) never reaches an answer or a confirmation,
// that a change names only what it changes, and that an answer after the state changed is refused.
import { randomUUID } from 'node:crypto';

import { Products } from '@mocco/common/project';
import {
  ComponentImpacts,
  IncidentPolicies,
  MonitorKinds,
  MonitorStates,
  monitorInputSchema,
} from '@mocco/common/status';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { createStatusDomain } from '@backend/domain/status/compose';
import { expectOne } from '@backend/infra/db/rows';
import {
  members,
  statusComponentGroups,
  statusComponents,
  statusMonitors,
  statusPages,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';
import { StatusGateMaintenanceTools } from '@backend/transport/mcp/tools/status-gate-maintenance';
import { StatusMonitorChangeTools } from '@backend/transport/mcp/tools/status-monitor-changes';
import { StatusStructureTools } from '@backend/transport/mcp/tools/status-page-structure';

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

const firstOf = <T>(rows: readonly T[]): T | undefined => rows.at(0);

/** What a monitor's check carries that must never reach an answer or a confirmation. */
const SECRETS = ['s3cret-pass', 'q-secret-token', '/health'];

describe('status page configuration over MCP (pglite, over HTTP)', () => {
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
  let platform: string;
  let office: string;
  let apiHealth: string;
  let theirMonitor: string;
  let gate: string;

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

  const pageRow = async (id: string) => expectOne(await t.db.select().from(statusPages).where(eq(statusPages.id, id)));
  const componentRow = async (id: string) =>
    firstOf(await t.db.select().from(statusComponents).where(eq(statusComponents.id, id)));
  const groupRow = async (id: string) =>
    firstOf(await t.db.select().from(statusComponentGroups).where(eq(statusComponentGroups.id, id)));
  const monitorRow = async (id: string) =>
    firstOf(await t.db.select().from(statusMonitors).where(eq(statusMonitors.id, id)));

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
    mine = await addWorkspace(ada);
    await t.db.insert(members).values({ organizationId: mine.workspaceId, userId: grace, role: 'member' });
    theirs = await addWorkspace();

    ({ id: pageId } = await status.statusPages.createPage(mine, ada, { slug: 'acme-status', title: 'Acme' }));
    ({ id: platform } = await status.statusPages.createGroup(mine, pageId, { name: 'Platform' }));
    ({ id: api } = await status.statusPages.createComponent(mine, pageId, { name: 'API', groupId: platform }));
    ({ id: web } = await status.statusPages.createComponent(mine, pageId, { name: 'Web' }));
    ({
      location: { id: office },
    } = await status.statusLocations.create(mine.workspaceId, ada, { code: 'office', name: 'Office' }));
    ({ id: apiHealth } = await status.statusMonitors.create(
      mine,
      ada,
      monitorInputSchema.parse({
        name: 'API health',
        spec: {
          kind: MonitorKinds.http,
          url: 'https://probe:s3cret-pass@api.acme.test:8443/health?token=q-secret-token',
        },
        locationIds: [office],
        components: [{ componentId: api, impactWhenDown: ComponentImpacts.majorOutage }],
      }),
    ));
    const theirOffice = await status.statusLocations.create(theirs.workspaceId, ada, { code: 'their', name: 'Theirs' });
    ({ id: theirMonitor } = await status.statusMonitors.create(
      theirs,
      ada,
      monitorInputSchema.parse({
        name: 'Their monitor',
        spec: { kind: MonitorKinds.tcp, host: 'their.test', port: 443 },
        locationIds: [theirOffice.location.id],
      }),
    ));
    ({ id: gate } = await status.statusMaintenances.setGateMaintenance(mine, ada, {
      pageId,
      gateName: 'migrate',
      title: 'Database migration',
      expectedMinutes: 15,
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

  const newMonitor = () => ({
    name: 'Checkout',
    spec: { kind: MonitorKinds.http, url: 'https://shop.acme.test/health?token=q-secret-token', method: 'GET' },
    locationIds: [office],
    components: [{ componentId: web, impactWhenDown: ComponentImpacts.partialOutage }],
    incidentPolicy: IncidentPolicies.publish,
  });

  const everyChange = (): [string, Record<string, unknown>][] => [
    [StatusStructureTools.createPage, { slug: 'x-page', title: 'X' }],
    [StatusStructureTools.updatePage, { pageId, title: 'X' }],
    [StatusStructureTools.createGroup, { pageId, name: 'X' }],
    [StatusStructureTools.updateGroup, { groupId: platform, name: 'X' }],
    [StatusStructureTools.deleteGroup, { groupId: platform }],
    [StatusStructureTools.createComponent, { pageId, name: 'X' }],
    [StatusStructureTools.updateComponent, { componentId: api, name: 'X' }],
    [StatusStructureTools.deleteComponent, { componentId: api }],
    [
      StatusMonitorChangeTools.create,
      { name: 'X', spec: { kind: 'tcp', host: 'x.test', port: 1 }, locationIds: [office] },
    ],
    [StatusMonitorChangeTools.update, { monitorId: apiHealth, name: 'X' }],
    [StatusMonitorChangeTools.pause, { monitorId: apiHealth }],
    [StatusMonitorChangeTools.resume, { monitorId: apiHealth }],
    [StatusMonitorChangeTools.delete, { monitorId: apiHealth }],
    [StatusGateMaintenanceTools.set, { pageId, gateName: 'x', title: 'X', expectedMinutes: 5 }],
    [StatusGateMaintenanceTools.delete, { gateMaintenanceId: gate }],
  ];

  describe('pages, groups and components', () => {
    it('creates a page once confirmed, saying its address is public at once', async () => {
      const args = { slug: 'acme-two', title: 'Acme two' };
      const { question } = await ask(StatusStructureTools.createPage, args);
      expect(question).toContain('at address acme-two');
      expect(question).toContain('PUBLIC');

      const body = bodyOf(await confirmed(StatusStructureTools.createPage, args));

      const created = await pageRow((body.page as Row).id as string);
      expect(created).toMatchObject({ slug: 'acme-two', title: 'Acme two', projectId: mine.projectId });
    });

    it("changes a page's address, warning that old links stop working, and refuses an answer after someone renamed it", async () => {
      const args = { pageId, slug: 'acme-new' };
      const stale = await ask(StatusStructureTools.updatePage, args);
      expect(stale.question).toContain('Address: acme-status → acme-new');
      expect(stale.question).toContain('Links to the old address stop working');
      await status.statusPages.updatePage(mine, pageId, { slug: 'acme-status', title: 'Acme Inc' });

      const late = await answer(StatusStructureTools.updatePage, args, stale.requestState);
      expect(late.result?.isError).toBe(true);
      expect(textOf(late)).toContain('different change');

      bodyOf(await confirmed(StatusStructureTools.updatePage, args));
      const changed = await pageRow(pageId);
      expect(changed).toMatchObject({ slug: 'acme-new', title: 'Acme Inc' });
    });

    it('refuses a taken address with the service refusal', async () => {
      await status.statusPages.createPage(theirs, ada, { slug: 'taken', title: 'Theirs' });

      const answered = await confirmed(StatusStructureTools.updatePage, { pageId, slug: 'taken' });

      expect(answered.result?.isError).toBe(true);
      expect(textOf(answered)).toContain('"taken" is taken');
    });

    it('adds, renames and deletes a group, its components staying ungrouped', async () => {
      const created = bodyOf(await confirmed(StatusStructureTools.createGroup, { pageId, name: 'Apps' }));
      const groupId = (created.group as Row).id as string;
      bodyOf(await confirmed(StatusStructureTools.updateGroup, { groupId, name: 'Applications' }));
      const renamed = await groupRow(groupId);
      expect(renamed?.name).toBe('Applications');

      const asked = await ask(StatusStructureTools.deleteGroup, { groupId: platform });
      expect(asked.question).toContain('ungrouped: API');
      bodyOf(await answer(StatusStructureTools.deleteGroup, { groupId: platform }, asked.requestState));

      expect(await groupRow(platform)).toBeUndefined();
      const ungrouped = await componentRow(api);
      expect(ungrouped?.groupId).toBeNull();
    });

    it('adds a component, changes only what is named, and deletes one, saying what it leaves', async () => {
      const created = bodyOf(
        await confirmed(StatusStructureTools.createComponent, { pageId, name: 'Search', groupId: platform }),
      );
      const searchId = (created.component as Row).id as string;
      const asked = await ask(StatusStructureTools.updateComponent, {
        componentId: searchId,
        description: 'Full text',
      });
      expect(asked.question).toContain('Description: none → Full text');
      expect(asked.question).not.toContain('Name:');
      bodyOf(
        await answer(
          StatusStructureTools.updateComponent,
          { componentId: searchId, description: 'Full text' },
          asked.requestState,
        ),
      );
      const described = await componentRow(searchId);
      expect(described).toMatchObject({ name: 'Search', description: 'Full text', groupId: platform });

      const deleting = await ask(StatusStructureTools.deleteComponent, { componentId: api });
      expect(deleting.question).toContain('every monitor that reports on it');
      expect(deleting.question).toContain('cannot be undone');
      bodyOf(await answer(StatusStructureTools.deleteComponent, { componentId: api }, deleting.requestState));
      expect(await componentRow(api)).toBeUndefined();
    });

    it('answering the same "add" twice adds one', async () => {
      const args = { pageId, name: 'Docs' };
      const { requestState } = await ask(StatusStructureTools.createComponent, args);

      bodyOf(await answer(StatusStructureTools.createComponent, args, requestState));
      const again = await answer(StatusStructureTools.createComponent, args, requestState);

      expect(again.result?.isError).toBe(true);
      const read = await status.statusPages.getPage(mine, pageId);
      expect(read.components.filter(each => each.name === 'Docs')).toHaveLength(1);
    });

    it('refuses a group of another page for a component, before asking', async () => {
      const other = await status.statusPages.createPage(mine, ada, { slug: 'acme-other', title: 'Other' });
      const otherGroup = await status.statusPages.createGroup(mine, other.id, { name: 'Elsewhere' });

      const answered = await call(StatusStructureTools.createComponent, { pageId, name: 'X', groupId: otherGroup.id });

      expect(answered.result?.resultType).not.toBe('input_required');
      expect(textOf(answered)).toContain('was not found');
    });
  });

  describe('monitors', () => {
    it('creates an HTTP monitor once confirmed, naming the host only and saying a publish policy is public', async () => {
      const { question, requestState } = await ask(StatusMonitorChangeTools.create, newMonitor());
      expect(question).toContain('Checks: http shop.acme.test (GET)');
      expect(question).toContain('Runs at: Office (office)');
      expect(question).toContain('Web (partial_outage while down)');
      expect(question).toContain('PUBLIC incident');
      expect(question).not.toContain('q-secret-token');

      const body = bodyOf(await answer(StatusMonitorChangeTools.create, newMonitor(), requestState));
      const again = await answer(StatusMonitorChangeTools.create, newMonitor(), requestState);

      const created = body.monitor as Row;
      expect(created).toMatchObject({ name: 'Checkout', target: 'shop.acme.test', state: MonitorStates.pending });
      expect(JSON.stringify(body)).not.toContain('q-secret-token');
      expect(again.result?.isError).toBe(true);
      const row = await monitorRow(created.id as string);
      expect(row?.createdByUserId).toBe(ada);
    });

    it('refuses a heartbeat, whose ping URL is a credential the console shows once', async () => {
      const answered = await call(StatusMonitorChangeTools.create, {
        ...newMonitor(),
        spec: { kind: MonitorKinds.heartbeat, periodSeconds: 3600, graceSeconds: 300 },
        locationIds: [],
      });

      expect(answered.result?.resultType).not.toBe('input_required');
      expect(answered.result?.isError).toBe(true);
    });

    it('changes only the settings named, keeping the check it never shows, and refuses an answer after someone saved', async () => {
      const args = { monitorId: apiHealth, intervalSeconds: 300 };
      const stale = await ask(StatusMonitorChangeTools.update, args);
      expect(stale.question).toContain('Every 60s');
      expect(stale.question).toContain('Every 300s');
      expect(SECRETS.filter(secret => stale.question.includes(secret))).toEqual([]);
      clock = new Date(T0.getTime() + 60_000);
      await status.statusMonitors.pause(mine, grace, apiHealth);
      await status.statusMonitors.resume(mine, grace, apiHealth);

      const late = await answer(StatusMonitorChangeTools.update, args, stale.requestState);
      expect(late.result?.isError).toBe(true);

      const body = bodyOf(await confirmed(StatusMonitorChangeTools.update, args));
      expect(JSON.stringify(body)).not.toContain('s3cret-pass');
      const row = await monitorRow(apiHealth);
      expect(row?.intervalSeconds).toBe(300);
      expect(row?.spec).toMatchObject({
        url: 'https://probe:s3cret-pass@api.acme.test:8443/health?token=q-secret-token',
      });
    });

    it('pauses, resumes and deletes a monitor once confirmed, and answers a pause of a paused one without asking', async () => {
      bodyOf(await confirmed(StatusMonitorChangeTools.pause, { monitorId: apiHealth }));
      const paused = await monitorRow(apiHealth);
      expect(paused?.state).toBe(MonitorStates.paused);
      expect(bodyOf(await call(StatusMonitorChangeTools.pause, { monitorId: apiHealth }))).toMatchObject({
        changed: false,
      });

      bodyOf(await confirmed(StatusMonitorChangeTools.resume, { monitorId: apiHealth }));
      const resumed = await monitorRow(apiHealth);
      expect(resumed?.state).toBe(MonitorStates.pending);

      const deleting = await ask(StatusMonitorChangeTools.delete, { monitorId: apiHealth });
      expect(deleting.question).toContain('cannot be undone');
      bodyOf(await answer(StatusMonitorChangeTools.delete, { monitorId: apiHealth }, deleting.requestState));
      expect(await monitorRow(apiHealth)).toBeUndefined();
    });

    it("refuses another workspace's monitor exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const foreign = await call(StatusMonitorChangeTools.delete, { monitorId: theirMonitor });
      const missing = await call(StatusMonitorChangeTools.delete, { monitorId: nowhere });

      expect(textOf(foreign).replace(theirMonitor, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(await monitorRow(theirMonitor)).toBeDefined();
    });
  });

  describe('gates that announce maintenance', () => {
    it('lists them, replaces one once confirmed showing what it announced, and removes one', async () => {
      const listed = bodyOf(await call(StatusGateMaintenanceTools.search, { pageId }, SIGN_IN));
      expect(listed.gateMaintenances).toEqual([
        expect.objectContaining({ id: gate, gateName: 'migrate', expectedMinutes: 15 }),
      ]);

      const args = {
        pageId,
        gateName: 'migrate',
        title: 'Schema change',
        expectedMinutes: 30,
        componentIds: [api, web],
      };
      const asked = await ask(StatusGateMaintenanceTools.set, args);
      expect(asked.question).toContain('Now: "Database migration", 15 minutes, covering API. This replaces it.');
      expect(asked.question).toContain('Covers: API, Web');
      bodyOf(await answer(StatusGateMaintenanceTools.set, args, asked.requestState));
      const replaced = await status.statusMaintenances.listGateMaintenances(mine, pageId);
      expect(replaced).toEqual([
        expect.objectContaining({ gateName: 'migrate', title: 'Schema change', expectedMinutes: 30 }),
      ]);

      bodyOf(await confirmed(StatusGateMaintenanceTools.delete, { gateMaintenanceId: gate }));
      expect(await status.statusMaintenances.listGateMaintenances(mine, pageId)).toEqual([]);
    });
  });

  describe('the locks every configuration change has', () => {
    it('challenges a token without status:write for it, for every change', async () => {
      const answers = await Promise.all(
        everyChange().map(async ([tool, args]) => {
          const answered = await call(tool, args, SIGN_IN);
          return [tool, answered.status];
        }),
      );

      expect(answers).toEqual(everyChange().map(([tool]) => [tool, 403]));
    });

    it('refuses every change where agents may not make changes, and changes nothing', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);

      const answers = await Promise.all(
        everyChange().map(async ([tool, args]) => ({ tool, answered: await call(tool, args) })),
      );

      expect(
        answers.map(({ tool, answered }) => [
          tool,
          answered.result?.isError,
          textOf(answered).includes('Settings → Agents'),
        ]),
      ).toEqual(everyChange().map(([tool]) => [tool, true, true]));
      expect(await monitorRow(apiHealth)).toBeDefined();
      expect(await componentRow(api)).toBeDefined();
    });
  });
});
