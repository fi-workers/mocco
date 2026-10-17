// The messenger setup tools over a real database, through the real HTTP handler: the settings
// read (never the identity secret), the rotation read, and the changes to the categories,
// guest access and the rotation. Each change has every lock a changing tool has
// (`messenger:write`, the workspace's opt-in, a confirmation bound to what it showed); until
// the person says yes nothing changes, and another workspace's project is out of reach.
import { randomUUID } from 'node:crypto';

import { AuditActions, type AuditAction } from '@mocco/common/audit';
import { Products } from '@mocco/common/project';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createMessengerDomain } from '@backend/domain/messenger/compose';
import { createProjectDomain } from '@backend/domain/project/instance';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, members, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { MessengerDomain } from '@backend/domain/messenger/compose';
import type { ProjectDomain } from '@backend/domain/project/instance';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the messenger tools must not reach another domain');
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
const WITH_MESSENGER_WRITE = [...SIGN_IN, 'messenger:write'];

const SETTINGS = 'mocco_messenger_settings_get';
const MEMBERS = 'mocco_messenger_inbox_members_list';
const CATEGORIES = 'mocco_messenger_categories_set';
const GUESTS = 'mocco_messenger_guest_access_set';
const ADD = 'mocco_messenger_inbox_members_add';
const REMOVE = 'mocco_messenger_inbox_members_remove';
const AVAILABILITY = 'mocco_messenger_inbox_members_set_availability';

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

interface Scope {
  workspaceId: string;
  projectId: string;
}

describe('mocco_messenger_* setup (pglite, over HTTP)', () => {
  let t: TestDb;
  let messenger: MessengerDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let ada: string;
  let bo: string;
  let eve: string;
  let mine: Scope;
  /** Another workspace's project, with its messenger set up. */
  let theirs: Scope;
  /** A project in Ada's workspace whose messenger was never set up. */
  let bare: string;

  async function call(
    tool: string,
    args: Record<string, unknown>,
    scopes = SIGN_IN,
    round: Round = {},
  ): Promise<RpcAnswer> {
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
        params: { name: tool, arguments: args, _meta: envelope, ...round },
      }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: 'agent',
        scopes,
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: ada },
      },
    });
    const text = await response.text();
    return {
      status: response.status,
      wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
      ...((text === '' ? {} : JSON.parse(text)) as RpcAnswer),
    };
  }

  async function ask(tool: string, args: Record<string, unknown>) {
    const asked = await call(tool, args, WITH_MESSENGER_WRITE);
    expect(asked.result?.resultType, textOf(asked)).toBe('input_required');
    return { asked, requestState: asked.result?.requestState ?? '' };
  }

  async function confirmed(tool: string, args: Record<string, unknown>, isConfirmed = true) {
    const { requestState } = await ask(tool, args);
    return await call(tool, args, WITH_MESSENGER_WRITE, { requestState, inputResponses: accepting(isConfirmed) });
  }

  /** Ada's workspace has two projects, so every call names the messenger's. */
  const inMine = (args: Record<string, unknown> = {}) => ({ projectId: mine.projectId, ...args });
  const settingsOf = async (scope: Scope = mine) =>
    await messenger.messengerSettings.get(scope.workspaceId, scope.projectId);
  const rotation = async () => await messenger.inbox.members(mine.workspaceId, mine.projectId);
  const categoriesNow = async () => {
    const row = await settingsOf();
    return row?.categories;
  };
  const guestsNow = async (scope: Scope = mine) => {
    const row = await settingsOf(scope);
    return row?.allowGuests;
  };
  const rotationIds = async () => {
    const rows = await rotation();
    return rows.map(member => member.userId);
  };
  const firstAvailable = async () => {
    const [first] = await rotation();
    return first?.available;
  };
  const audited = async (action: AuditAction) => await t.db.select().from(auditLog).where(eq(auditLog.action, action));

  const person = async (name: string, email: string) =>
    expectOne(await t.db.insert(users).values({ id: randomUUID(), name, email, emailVerified: true }).returning()).id;

  async function addWorkspace(...memberIds: string[]): Promise<Scope> {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    await Promise.all(
      memberIds.map(
        async userId => await t.db.insert(members).values({ organizationId: workspaceId, userId, role: 'member' }),
      ),
    );
    await project.products.enable(workspaceId, Products.messenger, memberIds[0] ?? ada);
    const created = await project.projects.create(workspaceId, { name: 'Shop', handle: 'shop' });
    return { workspaceId, projectId: created.id };
  }

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    messenger = createMessengerDomain(t.db, { audit, box: () => box });
    project = createProjectDomain(t.db);
    ada = await person('Ada', 'ada@acme.test');
    bo = await person('Bo', 'bo@acme.test');
    eve = await person('Eve', 'eve@acme.test');
    mine = await addWorkspace(ada, bo);
    theirs = await addWorkspace(eve);
    const lab = await project.projects.create(mine.workspaceId, { name: 'Lab', handle: 'lab' });
    bare = lab.id;
    await messenger.messengerSettings.enable(mine.workspaceId, mine.projectId, ada);
    await messenger.messengerSettings.enable(theirs.workspaceId, theirs.projectId, eve);
    await messenger.inbox.addMember(mine.workspaceId, mine.projectId, ada, ada);

    settings = createMcpSettingsService(t.db, new AuditService({ audit: new AuditRepo(t.db) }));
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
      helpPublic: { searchInProject: refuse, siteInProject: refuse, articleInProject: refuse },
      helpFeedback: { helpfulness: refuse },
      helpTranslations: { grid: refuse, reviewByShortId: refuse },
      helpGlossary: { list: refuse },
      messengerInbox: messenger.inbox,
      messengerSettings: messenger.messengerSettings,
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

  describe('the reads', () => {
    it('reads the settings without the identity secret, and says when the messenger is not set up', async () => {
      const set = bodyOf(await call(SETTINGS, inMine()));
      const notSet = bodyOf(await call(SETTINGS, { projectId: bare }));

      expect(set).toMatchObject({
        projectId: mine.projectId,
        isSetUp: true,
        allowGuests: false,
        categories: expect.arrayContaining([{ key: 'billing', label: expect.any(String) }]),
      });
      expect(JSON.stringify(set).toLowerCase()).not.toContain('secret');
      expect(notSet).toEqual({ workspaceId: mine.workspaceId, projectId: bare, isSetUp: false });
    });

    it("lists the rotation with availability, and never another workspace's", async () => {
      const listed = bodyOf(await call(MEMBERS, inMine()));
      const foreign = await call(MEMBERS, { workspaceId: theirs.workspaceId, projectId: theirs.projectId });

      expect(listed.members).toEqual([
        { userId: ada, name: 'Ada', email: 'ada@acme.test', available: true, lastAssignedAt: null },
      ]);
      expect(foreign.result?.isError).toBe(true);
    });
  });

  describe(CATEGORIES, () => {
    const next = [
      { key: 'billing', label: 'Billing' },
      { key: 'crash', label: 'The app crashed' },
    ];

    it('asks first with both lists, warning about removed keys, and changes nothing until answered', async () => {
      const before = await settingsOf();
      const { asked } = await ask(CATEGORIES, inMine({ categories: next }));

      expect(messageOf(asked)).toContain('Change the categories contacts pick from, as you?');
      expect(messageOf(asked)).toContain('crash: The app crashed');
      expect(messageOf(asked)).toContain('is refused when it starts a conversation');
      expect(await settingsOf()).toEqual(before);
    });

    it('replaces them once confirmed, recorded as the person', async () => {
      const body = bodyOf(await confirmed(CATEGORIES, inMine({ categories: next })));

      expect(body).toEqual({ changed: true, categories: next });
      expect(await categoriesNow()).toEqual(next);
      const [entry] = await audited(AuditActions.messengerCategoriesChanged);
      expect(entry).toMatchObject({ actorUserId: ada, payload: { categories: ['billing', 'crash'] } });
    });

    it('refuses a stale answer after someone else changed them, and answers without asking when equal', async () => {
      const { requestState } = await ask(CATEGORIES, inMine({ categories: next }));
      await messenger.messengerSettings.setCategories(mine.workspaceId, mine.projectId, bo, [
        { key: 'other', label: 'Other' },
      ]);
      const stale = await call(CATEGORIES, inMine({ categories: next }), WITH_MESSENGER_WRITE, {
        requestState,
        inputResponses: accepting(true),
      });
      const same = await call(
        CATEGORIES,
        inMine({ categories: [{ key: 'other', label: 'Other' }] }),
        WITH_MESSENGER_WRITE,
      );

      expect(textOf(stale)).toContain('different change');
      expect(await categoriesNow()).toEqual([{ key: 'other', label: 'Other' }]);
      expect(same.result?.resultType).not.toBe('input_required');
      expect(bodyOf(same)).toMatchObject({ changed: false });
    });

    it('refuses where the messenger is not set up, pointing at the console', async () => {
      const answer = await call(CATEGORIES, { projectId: bare, categories: next }, WITH_MESSENGER_WRITE);

      expect(answer.result?.resultType).not.toBe('input_required');
      expect(textOf(answer)).toContain("The messenger isn't set up for this project");
    });

    it('refuses duplicate keys at the boundary', async () => {
      const answer = await call(
        CATEGORIES,
        inMine({
          categories: [
            { key: 'a', label: 'A' },
            { key: 'a', label: 'Again' },
          ],
        }),
        WITH_MESSENGER_WRITE,
      );

      expect(answer.result?.isError ?? answer.result === undefined).toBe(true);
      expect(await categoriesNow()).not.toContainEqual({ key: 'a', label: 'A' });
    });
  });

  describe(GUESTS, () => {
    it('lets guests write once confirmed, recorded as the person, and turns it off the same way', async () => {
      const { asked } = await ask(GUESTS, inMine({ allowGuests: true }));
      expect(messageOf(asked)).toContain("Let people who aren't signed in write to your team, as you?");
      expect(await guestsNow()).toBe(false);

      bodyOf(await confirmed(GUESTS, inMine({ allowGuests: true })));
      expect(await guestsNow()).toBe(true);
      bodyOf(await confirmed(GUESTS, inMine({ allowGuests: false })));

      expect(await guestsNow()).toBe(false);
      const entries = await audited(AuditActions.messengerGuestsChanged);
      expect(entries.map(entry => [entry.actorUserId, entry.payload])).toEqual([
        [ada, { allowGuests: true }],
        [ada, { allowGuests: false }],
      ]);
    });

    it('changes nothing when told no, nor when it is so already', async () => {
      const declined = bodyOf(await confirmed(GUESTS, inMine({ allowGuests: true }), false));
      const already = await call(GUESTS, inMine({ allowGuests: false }), WITH_MESSENGER_WRITE);

      expect(declined).toMatchObject({ changed: false });
      expect(already.result?.resultType).not.toBe('input_required');
      expect(bodyOf(already)).toMatchObject({ changed: false, allowGuests: false });
      expect(await guestsNow()).toBe(false);
    });

    it("refuses another workspace's project, and where agents are not allowed", async () => {
      const foreign = await call(
        GUESTS,
        { workspaceId: theirs.workspaceId, projectId: theirs.projectId, allowGuests: true },
        WITH_MESSENGER_WRITE,
      );
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);
      const optedOut = await call(GUESTS, inMine({ allowGuests: true }), WITH_MESSENGER_WRITE);

      expect(foreign.result?.resultType).not.toBe('input_required');
      expect(foreign.result?.isError).toBe(true);
      expect(await guestsNow(theirs)).toBe(false);
      expect(textOf(optedOut)).toContain('Agents may not change messenger guest access in this workspace');
    });
  });

  describe('the rotation', () => {
    it('adds a workspace member once confirmed, recorded as the person', async () => {
      const { asked } = await ask(ADD, inMine({ userId: bo }));
      expect(messageOf(asked)).toContain("Add Bo (bo@acme.test) to this inbox's rotation, as you?");
      expect(await rotation()).toHaveLength(1);

      const body = bodyOf(await confirmed(ADD, inMine({ userId: bo })));

      expect(body).toEqual({ changed: true, userId: bo, available: true });
      expect(await rotationIds()).toEqual([ada, bo]);
      // The fixture added Ada first.
      const entries = await audited(AuditActions.messengerInboxMemberAdded);
      expect(entries.map(entry => [entry.actorUserId, entry.payload])).toEqual([
        [ada, { userId: ada }],
        [ada, { userId: bo }],
      ]);
    });

    it('refuses someone outside the workspace before asking, and answers without asking for a member already in', async () => {
      const outsider = await call(ADD, inMine({ userId: eve }), WITH_MESSENGER_WRITE);
      const already = await call(ADD, inMine({ userId: 'me' }), WITH_MESSENGER_WRITE);

      expect(outsider.result?.resultType).not.toBe('input_required');
      expect(textOf(outsider)).toContain("isn't a member of this workspace");
      expect(bodyOf(already)).toMatchObject({ changed: false, userId: ada });
      expect(await rotation()).toHaveLength(1);
    });

    it('takes someone out once confirmed, and answers without asking for someone not in it', async () => {
      const notIn = await call(REMOVE, inMine({ userId: bo }), WITH_MESSENGER_WRITE);
      const { asked } = await ask(REMOVE, inMine({ userId: 'me' }));
      const body = bodyOf(await confirmed(REMOVE, inMine({ userId: 'me' })));

      expect(bodyOf(notIn)).toMatchObject({ changed: false });
      expect(messageOf(asked)).toContain('the ones they have stay theirs');
      expect(body).toEqual({ changed: true, userId: ada });
      expect(await rotation()).toEqual([]);
      const [entry] = await audited(AuditActions.messengerInboxMemberRemoved);
      expect(entry).toMatchObject({ actorUserId: ada, payload: { userId: ada } });
    });

    it('marks the caller away and back once confirmed, binding the answer to their availability', async () => {
      const { asked, requestState } = await ask(AVAILABILITY, inMine({ available: false }));
      expect(messageOf(asked)).toContain('Mark yourself away, as you?');
      const round = { requestState, inputResponses: accepting(true) };

      const away = bodyOf(await call(AVAILABILITY, inMine({ available: false }), WITH_MESSENGER_WRITE, round));
      const again = await call(AVAILABILITY, inMine({ available: false }), WITH_MESSENGER_WRITE, round);
      const back = bodyOf(await confirmed(AVAILABILITY, inMine({ available: true })));

      expect(away).toEqual({ changed: true, userId: ada, available: false });
      // Away already: the second answer changes nothing.
      expect(bodyOf(again)).toMatchObject({ changed: false, available: false });
      expect(back).toEqual({ changed: true, userId: ada, available: true });
      expect(await firstAvailable()).toBe(true);
    });

    it('refuses the availability of someone not in the rotation, and changes nothing when told no', async () => {
      const notIn = await call(AVAILABILITY, inMine({ userId: bo, available: false }), WITH_MESSENGER_WRITE);
      const declined = bodyOf(await confirmed(AVAILABILITY, inMine({ available: false }), false));

      expect(notIn.result?.isError).toBe(true);
      expect(textOf(notIn)).toContain("not in this inbox's rotation");
      expect(declined).toMatchObject({ changed: false });
      expect(await firstAvailable()).toBe(true);
    });

    it('challenges a token without messenger:write for every rotation change', async () => {
      const answers = await Promise.all(
        [ADD, REMOVE, AVAILABILITY, CATEGORIES, GUESTS].map(
          async tool => await call(tool, inMine({ userId: bo, available: true, allowGuests: true, categories: [] })),
        ),
      );

      expect(answers.map(answer => answer.status)).toEqual([403, 403, 403, 403, 403]);
      expect(answers[0]?.wwwAuthenticate).toContain('scope="messenger:write openid profile email offline_access"');
      expect(await rotation()).toHaveLength(1);
    });
  });
});
