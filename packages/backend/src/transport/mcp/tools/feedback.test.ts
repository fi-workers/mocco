// `mocco_feedback_*` over a real database, through the real HTTP handler.
//
// The reads must stay inside the caller's project: another workspace's board or post reads
// exactly like one that does not exist. Moving a post changes what a public board shows, so the
// change has every lock a changing tool has: `feedback:write` (a token without it is challenged
// for it), the workspace's opt-in, and a confirmation that names the move from the post's
// status now; until the person says yes, nothing is written, and a confirmation for a post that
// has moved since is refused.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackPostStatuses } from '@mocco/common/feedback';
import { Products } from '@mocco/common/project';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createFeedbackDomain } from '@backend/domain/feedback/compose';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, feedbackPosts, feedbackStatusChanges, members, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { ProjectDomain } from '@backend/domain/project/instance';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  // The change confirms through a form elicitation.
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the feedback tools must not reach another domain');
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
  error?: { code: number; message: string };
}

/** A retry's answer to the confirmation, and the state it echoes. */
interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });
const messageOf = (answer: RpcAnswer) => answer.result?.inputRequests?.confirm?.params.message ?? '';
const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

const SIGN_IN = ['openid', 'profile', 'email', 'offline_access'];
const WITH_FEEDBACK_WRITE = [...SIGN_IN, 'feedback:write'];
const SET_STATUS = 'mocco_feedback_post_set_status';

type Row = Record<string, unknown>;

/** A successful answer's JSON; fails the test on a refusal, showing why. */
function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

const titlesOf = (body: Row) => (body.posts as Row[]).map(row => row.title);

interface Scope {
  workspaceId: string;
  projectId: string;
}

describe('mocco_feedback_* (pglite, over HTTP)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let ada: string;
  let eve: string;
  let mine: Scope;
  let theirs: Scope;
  let ideas: string;
  let mobile: string;
  /** Under review, in Mobile, with a long body. */
  let darkMode: string;
  /** Planned. */
  let exportCsv: string;
  /** Another workspace's board and post. */
  let foreignBoard: string;
  let foreignPost: string;

  async function call(
    tool: string,
    args: Record<string, unknown>,
    scopes = SIGN_IN,
    round: Round = {},
    userId = ada,
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
        extra: { [MCP_USER_ID]: userId },
      },
    });
    const text = await response.text();
    return {
      status: response.status,
      wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined,
      ...((text === '' ? {} : JSON.parse(text)) as RpcAnswer),
    };
  }

  const search = async (args: Record<string, unknown> = {}) =>
    bodyOf(await call('mocco_feedback_posts_search', { boardId: ideas, ...args }));

  /** The first round of the change, which must ask; returns the answer and the state to echo. */
  async function ask(args: Record<string, unknown>) {
    const asked = await call(SET_STATUS, args, WITH_FEEDBACK_WRITE);
    expect(asked.result?.resultType, textOf(asked)).toBe('input_required');
    return { asked, requestState: asked.result?.requestState ?? '' };
  }

  /** Ask, then answer: the whole round trip. */
  async function confirmed(args: Record<string, unknown>, isConfirmed = true) {
    const { requestState } = await ask(args);
    return await call(SET_STATUS, args, WITH_FEEDBACK_WRITE, { requestState, inputResponses: accepting(isConfirmed) });
  }

  const statusOf = async (postId: string) =>
    expectOne(await t.db.select().from(feedbackPosts).where(eq(feedbackPosts.id, postId))).status;

  const historyOf = async (postId: string) =>
    await t.db.select().from(feedbackStatusChanges).where(eq(feedbackStatusChanges.postId, postId));

  const person = async (name: string, email: string) =>
    expectOne(await t.db.insert(users).values({ id: randomUUID(), name, email, emailVerified: true }).returning()).id;

  async function addWorkspace(memberId: string): Promise<Scope> {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'member' });
    await project.products.enable(workspaceId, Products.feedback, memberId);
    const created = await project.projects.create(workspaceId, { name: 'Shop', handle: 'shop' });
    return { workspaceId, projectId: created.id };
  }

  beforeEach(async () => {
    t = await createTestDb();
    // A clock that moves, so each post is newer than the one before.
    let tick = Date.parse('2026-10-06T09:00:00Z');
    const now = () => {
      tick += 1000;
      return new Date(tick);
    };
    feedback = createFeedbackDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), now });
    project = createProjectDomain(t.db);
    ada = await person('Ada', 'ada@acme.test');
    eve = await person('Eve', 'eve@acme.test');
    mine = await addWorkspace(ada);
    theirs = await addWorkspace(eve);

    ({ id: ideas } = await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'ideas', name: 'Ideas' }));
    ({ id: mobile } = await feedback.feedbackBoards.createCategory(mine, ideas, { slug: 'mobile', name: 'Mobile' }));
    await feedback.feedbackBoards.createCategory(mine, ideas, { slug: 'api', name: 'API' });
    await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'bugs', name: 'Bugs', isPublic: false });
    // One at a time, so each post is newer than the one before.
    ({ id: darkMode } = await feedback.feedbackPosts.create(mine, ada, {
      boardId: ideas,
      title: 'Dark mode',
      body: 'Please. '.repeat(100),
      categoryId: mobile,
    }));
    ({ id: exportCsv } = await feedback.feedbackPosts.create(mine, ada, {
      boardId: ideas,
      title: 'Export CSV',
      status: FeedbackPostStatuses.planned,
    }));
    await feedback.feedbackPosts.create(mine, ada, {
      boardId: ideas,
      title: 'SSO',
      status: FeedbackPostStatuses.closed,
    });

    ({ id: foreignBoard } = await feedback.feedbackBoards.createBoard(theirs, eve, { slug: 'ideas', name: 'Theirs' }));
    ({ id: foreignPost } = await feedback.feedbackPosts.create(theirs, eve, {
      boardId: foreignBoard,
      title: 'Their secret plan',
    }));

    // The workspace allows agents to make changes; one test turns it off.
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
      messengerInbox: { list: refuse, get: refuse, write: refuse, assign: refuse, assignable: refuse },
      feedbackBoards: feedback.feedbackBoards,
      feedbackPosts: feedback.feedbackPosts,
      feedbackVotes: feedback.feedbackVotes,
      feedbackComments: feedback.feedbackComments,
      feedbackMerges: feedback.feedbackMerges,
      scope,
      projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
      settings,
      confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  describe('mocco_feedback_boards_list', () => {
    it("lists the project's boards with their categories in order, concise unless asked", async () => {
      const concise = bodyOf(await call('mocco_feedback_boards_list', {}));
      const detailed = bodyOf(await call('mocco_feedback_boards_list', { responseFormat: 'detailed' }));

      const boards = concise.boards as Row[];
      expect(new Set(boards.map(board => board.slug))).toEqual(new Set(['bugs', 'ideas']));
      expect(boards.find(board => board.id === ideas)).toEqual({
        id: ideas,
        slug: 'ideas',
        name: 'Ideas',
        isPublic: true,
        categories: [
          { id: mobile, name: 'Mobile' },
          { id: expect.any(String), name: 'API' },
        ],
      });
      expect((detailed.boards as Row[]).find(board => board.id === ideas)).toMatchObject({
        createdAt: expect.any(String),
        categories: [
          { id: mobile, name: 'Mobile', slug: 'mobile', position: 0 },
          { name: 'API', slug: 'api', position: 1 },
        ],
      });
      expect(textOf(await call('mocco_feedback_boards_list', {}))).not.toContain('Theirs');
    });

    it('refuses where the feedback product is off, as the console does', async () => {
      await project.products.disable(mine.workspaceId, Products.feedback);

      const answer = await call('mocco_feedback_boards_list', {});

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain('not enabled');
    });
  });

  describe('mocco_feedback_posts_search', () => {
    it('lists a board by status in workflow order, concise unless asked', async () => {
      const concise = await search();
      const detailed = await search({ responseFormat: 'detailed' });

      expect(titlesOf(concise)).toEqual(['Dark mode', 'Export CSV', 'SSO']);
      expect((concise.posts as Row[])[0]).toEqual({
        id: darkMode,
        number: 1,
        title: 'Dark mode',
        status: 'under_review',
        categoryId: mobile,
        createdAt: expect.any(String),
      });
      expect(concise).not.toHaveProperty('nextOffset');
      expect((detailed.posts as Row[])[0]).toMatchObject({
        isBodyCut: true,
        shippedAt: null,
        authorUserId: ada,
      });
      expect(((detailed.posts as Row[])[0]?.body as string).length).toBeLessThan(600);
    });

    it('filters by status and category, sorts newest first, and pages', async () => {
      expect(titlesOf(await search({ status: 'planned' }))).toEqual(['Export CSV']);
      expect(titlesOf(await search({ categoryId: mobile }))).toEqual(['Dark mode']);
      expect(titlesOf(await search({ sort: 'newest' }))).toEqual(['SSO', 'Export CSV', 'Dark mode']);

      const first = await search({ limit: 2 });
      const second = await search({ limit: 2, offset: first.nextOffset });
      expect(titlesOf(first)).toEqual(['Dark mode', 'Export CSV']);
      expect(first.nextOffset).toBe(2);
      expect(titlesOf(second)).toEqual(['SSO']);
      expect(second).not.toHaveProperty('nextOffset');
    });

    it("refuses another workspace's board exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const theirsAnswer = await call('mocco_feedback_posts_search', { boardId: foreignBoard });
      const missing = await call('mocco_feedback_posts_search', { boardId: nowhere });
      const throughTheirWorkspace = await call('mocco_feedback_posts_search', {
        boardId: foreignBoard,
        workspaceId: theirs.workspaceId,
      });
      const throughTheirProject = await call('mocco_feedback_posts_search', {
        boardId: foreignBoard,
        projectId: theirs.projectId,
      });

      expect(theirsAnswer.result?.isError).toBe(true);
      expect(textOf(theirsAnswer)).toContain('was not found');
      expect(textOf(theirsAnswer).replace(foreignBoard, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(throughTheirWorkspace.result?.isError).toBe(true);
      expect(throughTheirProject.result?.isError).toBe(true);
      expect(textOf(throughTheirProject)).not.toContain('Their secret plan');
    });
  });

  describe('mocco_feedback_post_get', () => {
    it('reads the post with its history, cutting the body short unless detailed', async () => {
      await feedback.feedbackPosts.setStatus(mine, ada, darkMode, FeedbackPostStatuses.planned);

      const concise = bodyOf(await call('mocco_feedback_post_get', { postId: darkMode }));
      const detailed = bodyOf(await call('mocco_feedback_post_get', { postId: darkMode, responseFormat: 'detailed' }));

      expect(concise.post).toMatchObject({
        id: darkMode,
        boardId: ideas,
        number: 1,
        title: 'Dark mode',
        status: 'planned',
        categoryId: mobile,
        isBodyCut: true,
      });
      expect(concise.history).toEqual([
        { from: null, to: 'under_review', reason: 'created', at: expect.any(String) },
        { from: 'under_review', to: 'planned', reason: 'manual', at: expect.any(String) },
      ]);
      expect(detailed.post).toMatchObject({ body: 'Please. '.repeat(100), authorUserId: ada });
      expect(detailed.post).not.toHaveProperty('isBodyCut');
      expect((detailed.history as Row[])[1]).toMatchObject({ actorUserId: ada });
    });

    it("refuses another workspace's post exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const theirsAnswer = await call('mocco_feedback_post_get', { postId: foreignPost });
      const missing = await call('mocco_feedback_post_get', { postId: nowhere });
      const asEve = await call(
        'mocco_feedback_post_get',
        { postId: darkMode, workspaceId: mine.workspaceId },
        SIGN_IN,
        {},
        eve,
      );

      expect(theirsAnswer.result?.isError).toBe(true);
      expect(textOf(theirsAnswer).replace(foreignPost, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(theirsAnswer)).not.toContain('Their secret plan');
      // Eve is not in this workspace at all.
      expect(asEve.result?.isError).toBe(true);
      expect(textOf(asEve)).not.toContain('Dark mode');
    });
  });

  describe('mocco_feedback_post_set_status', () => {
    it('asks first, naming the post and the move, and writes nothing until answered', async () => {
      const { asked } = await ask({ postId: exportCsv, status: 'shipped' });

      expect(messageOf(asked)).toContain('Move feedback post #2 "Export CSV", as you?');
      expect(messageOf(asked)).toContain('From: planned');
      expect(messageOf(asked)).toContain('To: shipped');
      expect(await statusOf(exportCsv)).toBe('planned');
      expect(await historyOf(exportCsv)).toHaveLength(1);
    });

    it('moves the post as the person once confirmed, recorded in its history and the audit log', async () => {
      const body = bodyOf(await confirmed({ postId: exportCsv, status: 'shipped' }));

      expect(body).toMatchObject({
        changed: true,
        postId: exportCsv,
        number: 2,
        from: 'planned',
        to: 'shipped',
        shippedAt: expect.any(String),
      });
      expect(await statusOf(exportCsv)).toBe('shipped');
      const [entry] = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditActions.feedbackPostStatusChanged));
      expect(entry).toMatchObject({
        actorUserId: ada,
        subjectId: exportCsv,
        payload: { projectId: mine.projectId, from: 'planned', to: 'shipped' },
      });
    });

    it('moves nothing when the person says no', async () => {
      const body = bodyOf(await confirmed({ postId: exportCsv, status: 'shipped' }, false));

      expect(body).toMatchObject({ changed: false });
      expect(await statusOf(exportCsv)).toBe('planned');
      expect(await historyOf(exportCsv)).toHaveLength(1);
    });

    it('says so without asking when the post has the status already', async () => {
      const answer = await call(SET_STATUS, { postId: exportCsv, status: 'planned' }, WITH_FEEDBACK_WRITE);

      expect(answer.result?.resultType).not.toBe('input_required');
      expect(bodyOf(answer)).toMatchObject({ changed: false, status: 'planned' });
    });

    it('refuses a confirmation once the post has moved since, and one replayed for another post or status', async () => {
      const args = { postId: exportCsv, status: 'shipped' };
      const { requestState } = await ask(args);
      const round = { requestState, inputResponses: accepting(true) };

      const otherPost = await call(SET_STATUS, { ...args, postId: darkMode }, WITH_FEEDBACK_WRITE, round);
      const otherStatus = await call(SET_STATUS, { ...args, status: 'closed' }, WITH_FEEDBACK_WRITE, round);
      // Someone moves it in the console before the person answers.
      await feedback.feedbackPosts.setStatus(mine, ada, exportCsv, FeedbackPostStatuses.inProgress);
      const stale = await call(SET_STATUS, args, WITH_FEEDBACK_WRITE, round);

      expect(textOf(otherPost)).toContain('different change');
      expect(textOf(otherStatus)).toContain('different change');
      expect(stale.result?.isError).toBe(true);
      expect(textOf(stale)).toContain('different change');
      expect(await statusOf(exportCsv)).toBe('in_progress');
      expect(await statusOf(darkMode)).toBe('under_review');
    });

    it('applies a confirmation answered twice once, and refuses the second', async () => {
      const args = { postId: exportCsv, status: 'shipped' };
      const { requestState } = await ask(args);
      const round = { requestState, inputResponses: accepting(true) };

      const first = await call(SET_STATUS, args, WITH_FEEDBACK_WRITE, round);
      const again = await call(SET_STATUS, args, WITH_FEEDBACK_WRITE, round);

      expect(bodyOf(first)).toMatchObject({ changed: true });
      // It is shipped now, so the second answer changes nothing.
      expect(bodyOf(again)).toMatchObject({ changed: false, status: 'shipped' });
      expect(await historyOf(exportCsv)).toHaveLength(2);
    });

    it('refuses in a workspace that has not allowed agents to make changes, and says where to change it', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);

      const answer = await call(SET_STATUS, { postId: exportCsv, status: 'shipped' }, WITH_FEEDBACK_WRITE);

      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.resultType).not.toBe('input_required');
      expect(textOf(answer)).toContain('Agents may not change feedback statuses in this workspace');
      expect(textOf(answer)).toContain('Settings → Agents');
      expect(await statusOf(exportCsv)).toBe('planned');
    });

    it('challenges a token without feedback:write for it, keeping the scopes it has, and writes nothing', async () => {
      const answer = await call(SET_STATUS, { postId: exportCsv, status: 'shipped' });
      // messenger:write is not feedback:write.
      const other = await call(SET_STATUS, { postId: exportCsv, status: 'shipped' }, [...SIGN_IN, 'messenger:write']);

      expect(answer.status).toBe(403);
      expect(answer.wwwAuthenticate).toContain('error="insufficient_scope"');
      expect(answer.wwwAuthenticate).toContain('scope="feedback:write openid profile email offline_access"');
      expect(other.status).toBe(403);
      expect(other.wwwAuthenticate).toContain(
        'scope="feedback:write openid profile email offline_access messenger:write"',
      );
      expect(await statusOf(exportCsv)).toBe('planned');
    });

    it("refuses another workspace's post before asking anything, exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const theirsAnswer = await call(SET_STATUS, { postId: foreignPost, status: 'shipped' }, WITH_FEEDBACK_WRITE);
      const missing = await call(SET_STATUS, { postId: nowhere, status: 'shipped' }, WITH_FEEDBACK_WRITE);
      const asEve = await call(
        SET_STATUS,
        { postId: exportCsv, status: 'shipped', workspaceId: mine.workspaceId },
        WITH_FEEDBACK_WRITE,
        {},
        eve,
      );

      expect(theirsAnswer.result?.resultType).not.toBe('input_required');
      expect(theirsAnswer.result?.isError).toBe(true);
      expect(textOf(theirsAnswer).replace(foreignPost, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(asEve.result?.isError).toBe(true);
      expect(asEve.result?.resultType).not.toBe('input_required');
      expect(await statusOf(foreignPost)).toBe('under_review');
      expect(await statusOf(exportCsv)).toBe('planned');
    });
  });

  it('marks the reads read-only and the change as a change', async () => {
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
    const hintsOf = (name: string) => listed.result.tools.find(each => each.name === name)?.annotations;

    expect(hintsOf('mocco_feedback_boards_list')).toMatchObject({ readOnlyHint: true });
    expect(hintsOf('mocco_feedback_posts_search')).toMatchObject({ readOnlyHint: true });
    expect(hintsOf('mocco_feedback_post_get')).toMatchObject({ readOnlyHint: true });
    expect(hintsOf(SET_STATUS)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
