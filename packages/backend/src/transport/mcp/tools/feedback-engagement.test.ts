// `mocco_feedback_votes_list`, `_comments_list`, `_comment_create`, `_post_vote` and `_post_merge`
// over a real database, through the real HTTP handler.
//
// The reads stay inside the caller's project. The three changes have every lock a changing tool
// has (`feedback:write`, the workspace's opt-in, a confirmation naming exactly what would
// change), write nothing until the person says yes, and refuse an answer once the state it was
// asked about has changed: a vote added since, a post voted on or merged since.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackVoteSources, FeedbackVoteStates } from '@mocco/common/feedback';
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
import { auditLog, feedbackComments, feedbackPosts, members, users, workspaces } from '@backend/infra/db/schema';
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
}

interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });
const messageOf = (answer: RpcAnswer) => answer.result?.inputRequests?.confirm?.params.message ?? '';
const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

const SIGN_IN = ['openid', 'profile', 'email', 'offline_access'];
const WRITE = [...SIGN_IN, 'feedback:write'];
const VOTES = 'mocco_feedback_votes_list';
const COMMENTS = 'mocco_feedback_comments_list';
const COMMENT = 'mocco_feedback_comment_create';
const VOTE = 'mocco_feedback_post_vote';
const MERGE = 'mocco_feedback_post_merge';

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

interface Scope {
  workspaceId: string;
  projectId: string;
}

describe('mocco_feedback votes, comments and merging (pglite, over HTTP)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let ada: string;
  let mine: Scope;
  let ideas: string;
  /** Voted for by ann (counted) and bob (pending); one comment of each kind. */
  let darkMode: string;
  /** A duplicate of dark mode, voted for by ann and cy. */
  let darkTheme: string;
  /** On another board of the project. */
  let crash: string;
  /** Another workspace's post. */
  let foreignPost: string;

  async function call(tool: string, args: Record<string, unknown>, scopes = SIGN_IN, round: Round = {}) {
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

  /** The first round of a change, which must ask. */
  async function ask(tool: string, args: Record<string, unknown>) {
    const asked = await call(tool, args, WRITE);
    expect(asked.result?.resultType, textOf(asked)).toBe('input_required');
    return { asked, requestState: asked.result?.requestState ?? '' };
  }

  const answer = async (tool: string, args: Record<string, unknown>, requestState: string, isConfirmed = true) =>
    await call(tool, args, WRITE, { requestState, inputResponses: accepting(isConfirmed) });

  async function confirmed(tool: string, args: Record<string, unknown>) {
    const { requestState } = await ask(tool, args);
    return await answer(tool, args, requestState);
  }

  const commentArgs = () => ({ postId: darkMode, body: 'Planned for Q4', isOfficial: true });
  const mergeArgs = () => ({ postId: darkTheme, intoPostId: darkMode });
  const postOf = async (postId: string) =>
    expectOne(await t.db.select().from(feedbackPosts).where(eq(feedbackPosts.id, postId)));
  const postField = async <K extends keyof typeof feedbackPosts.$inferSelect>(postId: string, key: K) => {
    const row = await postOf(postId);
    return row[key];
  };
  const commentsOn = async (postId: string) =>
    await t.db.select().from(feedbackComments).where(eq(feedbackComments.postId, postId));

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
    let tick = Date.parse('2026-10-06T09:00:00Z');
    const now = () => {
      tick += 1000;
      return new Date(tick);
    };
    feedback = createFeedbackDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), now });
    project = createProjectDomain(t.db);
    ada = await person('Ada', 'ada@acme.test');
    const eve = await person('Eve', 'eve@acme.test');
    mine = await addWorkspace(ada);
    const theirs = await addWorkspace(eve);

    ({ id: ideas } = await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'ideas', name: 'Ideas' }));
    const bugs = await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'bugs', name: 'Bugs' });
    ({ id: darkMode } = await feedback.feedbackPosts.create(mine, ada, { boardId: ideas, title: 'Dark mode' }));
    ({ id: darkTheme } = await feedback.feedbackPosts.create(mine, ada, { boardId: ideas, title: 'Dark theme' }));
    ({ id: crash } = await feedback.feedbackPosts.create(mine, ada, { boardId: bugs.id, title: 'Crash' }));
    const web = { source: FeedbackVoteSources.web };
    await feedback.feedbackVotes.vote(mine, darkMode, 'ann', web);
    await feedback.feedbackVotes.vote(mine, darkMode, 'bob', { ...web, state: FeedbackVoteStates.pending });
    await feedback.feedbackVotes.vote(mine, darkTheme, 'ann', web);
    await feedback.feedbackVotes.vote(mine, darkTheme, 'cy', web);
    await feedback.feedbackComments.createAsEndUser(mine, darkMode, 'ann', 'Me too. '.repeat(100));
    await feedback.feedbackComments.createAsStaff(mine, ada, darkMode, {
      body: 'Blocked on theming',
      isOfficial: false,
      isInternal: true,
    });

    const foreignBoard = await feedback.feedbackBoards.createBoard(theirs, eve, { slug: 'ideas', name: 'Theirs' });
    ({ id: foreignPost } = await feedback.feedbackPosts.create(theirs, eve, {
      boardId: foreignBoard.id,
      title: 'Their secret plan',
    }));
    await feedback.feedbackVotes.vote(theirs, foreignPost, 'their-user', web);
    await feedback.feedbackComments.createAsStaff(theirs, eve, foreignPost, {
      body: 'Their secret note',
      isOfficial: false,
      isInternal: true,
    });

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
      helpTranslations: { grid: refuse, reviewByShortId: refuse, acceptProposal: refuse, retranslate: refuse },
      helpGlossary: { list: refuse, addTerm: refuse, updateTerm: refuse, removeTerm: refuse },
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

  describe('reads', () => {
    it("lists a post's votes, newest first, concise unless asked, and pages", async () => {
      const concise = bodyOf(await call(VOTES, { postId: darkMode }));
      expect(concise.votes).toEqual([
        { endUserId: 'bob', state: FeedbackVoteStates.pending, createdAt: expect.any(String) },
        { endUserId: 'ann', state: FeedbackVoteStates.counted, createdAt: expect.any(String) },
      ]);
      const detailed = bodyOf(await call(VOTES, { postId: darkMode, responseFormat: 'detailed', limit: 1 }));
      expect(detailed.votes).toEqual([
        expect.objectContaining({ endUserId: 'bob', source: FeedbackVoteSources.web, countedAt: null }),
      ]);
      expect(detailed.nextOffset).toBe(1);
      const next = bodyOf(await call(VOTES, { postId: darkMode, offset: 1 }));
      expect((next.votes as Row[]).map(row => row.endUserId)).toEqual(['ann']);
      expect(next).not.toHaveProperty('nextOffset');
    });

    it("lists a post's comments as the team sees them, internal notes marked, the body cut unless detailed", async () => {
      const concise = bodyOf(await call(COMMENTS, { postId: darkMode }));
      const [fromAnn, note] = concise.comments as Row[];
      expect(fromAnn).toMatchObject({ authorKind: 'end_user', isInternal: false, isBodyCut: true });
      expect(note).toMatchObject({ authorKind: 'staff', isInternal: true, body: 'Blocked on theming' });
      const detailed = bodyOf(await call(COMMENTS, { postId: darkMode, responseFormat: 'detailed' }));
      expect(detailed.comments).toEqual([
        expect.objectContaining({ authorEndUserId: 'ann', body: 'Me too. '.repeat(100) }),
        expect.objectContaining({ authorUserId: ada }),
      ]);
    });

    it("refuses another workspace's post exactly as one that does not exist", async () => {
      const nowhere = randomUUID();
      const tools = [VOTES, COMMENTS];
      await tools.reduce(async (previous, tool) => {
        await previous;
        const theirs = await call(tool, { postId: foreignPost });
        const missing = await call(tool, { postId: nowhere });
        expect(theirs.result?.isError).toBe(true);
        expect(textOf(theirs).replace(foreignPost, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
        expect(textOf(theirs)).not.toContain('secret');
      }, Promise.resolve());
    });
  });

  describe(COMMENT, () => {
    it('asks first, naming the post, the kind and the text, and writes nothing until answered', async () => {
      const { asked } = await ask(COMMENT, commentArgs());
      expect(messageOf(asked)).toContain('#1 "Dark mode"');
      expect(messageOf(asked)).toContain('the official response (public)');
      expect(messageOf(asked)).toContain('Planned for Q4');
      expect(await commentsOn(darkMode)).toHaveLength(2);
    });

    it('comments as the person once confirmed, and not when they say no', async () => {
      const { requestState } = await ask(COMMENT, commentArgs());
      const declined = await answer(COMMENT, commentArgs(), requestState, false);
      expect(bodyOf(declined)).toMatchObject({ changed: false });
      const created = bodyOf(await confirmed(COMMENT, commentArgs()));
      expect(created).toMatchObject({ created: true, isOfficial: true, isInternal: false });
      const rows = await commentsOn(darkMode);
      expect(rows.find(row => row.id === created.commentId)).toMatchObject({
        authorUserId: ada,
        body: 'Planned for Q4',
        isOfficial: true,
      });
      expect(await postField(darkMode, 'commentCount')).toBe(2);
    });

    it('refuses a confirmation replayed for other text, and an official internal note without asking', async () => {
      const { requestState } = await ask(COMMENT, commentArgs());
      const replayed = await answer(COMMENT, { ...commentArgs(), body: 'Never mind' }, requestState);
      expect(textOf(replayed)).toContain('different change');
      const both = await call(COMMENT, { ...commentArgs(), isInternal: true }, WRITE);
      expect(both.result?.isError).toBe(true);
      expect(both.result?.resultType).not.toBe('input_required');
      expect(await commentsOn(darkMode)).toHaveLength(2);
    });
  });

  describe(VOTE, () => {
    it('asks first, then records the vote for the end user as the person, and they follow the post', async () => {
      const { asked } = await ask(VOTE, { postId: darkMode, endUserId: 'dee' });
      expect(messageOf(asked)).toContain('"dee"');
      expect(messageOf(asked)).toContain('Votes now: 1');
      expect(await postField(darkMode, 'voteCount')).toBe(1);

      const voted = bodyOf(await confirmed(VOTE, { postId: darkMode, endUserId: 'dee' }));
      expect(voted).toMatchObject({ changed: true, state: FeedbackVoteStates.counted, voteCount: 2 });
      const vote = await feedback.feedbackVotes.find(mine, darkMode, 'dee');
      expect(vote).toMatchObject({ source: FeedbackVoteSources.staff, recordedByUserId: ada });
      const subscribers = await feedback.feedbackSubscriptions.list(mine, darkMode, { limit: 10, offset: 0 });
      expect(subscribers.map(row => row.endUserId)).toContain('dee');
    });

    it("counts a pending vote, and says so without asking when the end user's vote counts already", async () => {
      const counted = bodyOf(await confirmed(VOTE, { postId: darkMode, endUserId: 'bob' }));
      expect(counted).toMatchObject({ changed: true, voteCount: 2 });
      const already = await call(VOTE, { postId: darkMode, endUserId: 'ann' }, WRITE);
      expect(already.result?.resultType).not.toBe('input_required');
      expect(bodyOf(already)).toMatchObject({ changed: false });
    });

    it('refuses a confirmation once the end user has voted since', async () => {
      const { requestState } = await ask(VOTE, { postId: darkMode, endUserId: 'dee' });
      await feedback.feedbackVotes.vote(mine, darkMode, 'dee', {
        source: FeedbackVoteSources.web,
        state: FeedbackVoteStates.pending,
      });
      const stale = await answer(VOTE, { postId: darkMode, endUserId: 'dee' }, requestState);
      expect(textOf(stale)).toContain('different change');
      expect(await postField(darkMode, 'voteCount')).toBe(1);
    });

    it('refuses a merged post before asking, saying where its votes went', async () => {
      await feedback.feedbackMerges.merge(mine, ada, darkTheme, darkMode);
      const refused = await call(VOTE, { postId: darkTheme, endUserId: 'dee' }, WRITE);
      expect(refused.result?.isError).toBe(true);
      expect(textOf(refused)).toContain(darkMode);
    });
  });

  describe(MERGE, () => {
    it('asks first, naming both posts and their votes, and merges nothing until answered', async () => {
      const { asked } = await ask(MERGE, mergeArgs());
      expect(messageOf(asked)).toContain('#2 "Dark theme" into #1 "Dark mode"');
      expect(messageOf(asked)).toContain('Votes: 2 on the duplicate, 1 on the post it joins');
      expect(await postField(darkTheme, 'mergedIntoPostId')).toBeNull();
    });

    it('merges as the person once confirmed: the votes move, each voter once, and it is audited', async () => {
      const merged = bodyOf(await confirmed(MERGE, mergeArgs()));
      // ann voted on both; cy moves over; bob's pending vote stays pending.
      expect(merged).toMatchObject({ merged: true, postId: darkTheme, intoPostId: darkMode, voteCount: 2 });
      const source = await postOf(darkTheme);
      expect(source).toMatchObject({ mergedIntoPostId: darkMode, status: 'closed' });
      const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.feedbackPostMerged));
      expect(audit.map(row => [row.subjectId, row.actorUserId])).toEqual([[darkTheme, ada]]);
    });

    it('refuses a confirmation once either post was voted on, and asks again', async () => {
      const { requestState } = await ask(MERGE, mergeArgs());
      await feedback.feedbackVotes.vote(mine, darkMode, 'dee', { source: FeedbackVoteSources.web });
      const stale = await answer(MERGE, mergeArgs(), requestState);
      expect(textOf(stale)).toContain('different change');
      expect(await postField(darkTheme, 'mergedIntoPostId')).toBeNull();
      const { asked } = await ask(MERGE, mergeArgs());
      expect(messageOf(asked)).toContain('2 on the post it joins');
    });

    it('refuses an answer once either post was merged elsewhere, without asking again', async () => {
      const { requestState } = await ask(MERGE, mergeArgs());
      await feedback.feedbackMerges.merge(mine, ada, darkMode, darkTheme);
      const stale = await answer(MERGE, mergeArgs(), requestState);
      expect(stale.result?.isError).toBe(true);
      expect(stale.result?.resultType).not.toBe('input_required');
      expect(textOf(stale)).toContain('merged');
      expect(await postField(darkTheme, 'mergedIntoPostId')).toBeNull();
    });

    it('refuses a post into itself, across boards, and into another workspace, before asking', async () => {
      const cases = [
        { postId: darkTheme, intoPostId: darkTheme },
        { postId: darkTheme, intoPostId: crash },
        { postId: darkTheme, intoPostId: foreignPost },
      ];
      const answers = await cases.reduce<Promise<RpcAnswer[]>>(async (previous, each) => {
        const done = await previous;
        return [...done, await call(MERGE, each, WRITE)];
      }, Promise.resolve([]));
      expect(answers.map(each => [each.result?.isError, each.result?.resultType === 'input_required'])).toEqual([
        [true, false],
        [true, false],
        [true, false],
      ]);
      // Another workspace's post reads exactly like one that does not exist.
      const nowhere = randomUUID();
      const missing = await call(MERGE, { postId: darkTheme, intoPostId: nowhere }, WRITE);
      expect(textOf(answers[2] ?? {}).replace(foreignPost, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(await postField(darkTheme, 'mergedIntoPostId')).toBeNull();
      expect(await postField(foreignPost, 'voteCount')).toBe(1);
    });
  });

  describe('locks', () => {
    const changes: [string, Record<string, unknown>][] = [
      [COMMENT, { body: 'x' }],
      [VOTE, { endUserId: 'dee' }],
      [MERGE, { intoPostId: randomUUID() }],
    ];

    it('challenges a token without feedback:write for it, keeping the scopes it has', async () => {
      await changes.reduce(async (previous, [tool, extra]) => {
        await previous;
        const challenged = await call(tool, { postId: darkTheme, ...extra });
        expect(challenged.status, tool).toBe(403);
        expect(challenged.wwwAuthenticate).toContain('insufficient_scope');
        expect(challenged.wwwAuthenticate).toContain('feedback:write');
        expect(challenged.wwwAuthenticate).toContain('openid');
      }, Promise.resolve());
    });

    it('refuses where the workspace has not allowed agents to make changes, and says where to change it', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);
      await changes.reduce(async (previous, [tool, extra]) => {
        await previous;
        const refused = await call(tool, { postId: darkTheme, ...extra }, WRITE);
        expect(refused.result?.isError, tool).toBe(true);
        expect(textOf(refused)).toContain('Settings → Agents');
      }, Promise.resolve());
      expect(await commentsOn(darkTheme)).toEqual([]);
    });
  });

  it('marks the reads read-only, the merge destructive and the others as changes', async () => {
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
    expect(hintsOf(VOTES)).toMatchObject({ readOnlyHint: true });
    expect(hintsOf(COMMENTS)).toMatchObject({ readOnlyHint: true });
    expect(hintsOf(COMMENT)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hintsOf(VOTE)).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(hintsOf(MERGE)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
