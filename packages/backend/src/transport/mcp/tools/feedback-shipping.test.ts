// `mocco_feedback_ship_suggestions_list`, `_accept` and `_dismiss` over a real database, through
// the real HTTP handler. The suggestions come from the real ShipDetector on a seeded release whose
// commit is each link's merge commit, so no GitHub call is made.
//
// The read stays inside the caller's project. The two changes have every lock a changing tool has
// (`feedback:write`, the workspace's opt-in, a confirmation naming the run and each post), write
// nothing until the person says yes, and refuse an answer once the run's suggestions or a post's
// status changed since they were asked.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import {
  ChangelogEntryStates,
  FeedbackLinkKinds,
  FeedbackLinkStates,
  FeedbackPostStatuses,
  FeedbackStatusChangeReasons,
  FeedbackVoteSources,
  ShipModes,
  ShipPolicies,
  ShipSuggestionStates,
} from '@mocco/common/feedback';
import { Products } from '@mocco/common/project';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createFeedbackDomain, createShipDetector } from '@backend/domain/feedback/compose';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { seedRepo, seedRun } from '@backend/domain/status/testing/deploys';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  feedbackLinks,
  feedbackPosts,
  feedbackShipSuggestions,
  feedbackStatusChanges,
  members,
  users,
  workspaces,
} from '@backend/infra/db/schema';
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
const LIST = 'mocco_feedback_ship_suggestions_list';
const ACCEPT = 'mocco_feedback_ship_suggestions_accept';
const DISMISS = 'mocco_feedback_ship_suggestions_dismiss';

type Row = Record<string, unknown>;

/** Refused, and not asked. */
function expectRefused(refusal: RpcAnswer) {
  expect(refusal.result?.isError, textOf(refusal)).toBe(true);
  expect(refusal.result?.resultType).not.toBe('input_required');
}

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

interface Scope {
  workspaceId: string;
  projectId: string;
}

/** A project with a repo, and a board whose releases of that repo ship its posts. */
interface Shop extends Scope {
  repoId: string;
  boardId: string;
}

describe('mocco_feedback ship suggestions (pglite, over HTTP)', () => {
  let t: TestDb;
  let feedback: FeedbackDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let now: Date;
  let ada: string;
  let mine: Shop;
  /** Suggested by `run` on mine's board, in progress, with 1 and 0 votes. */
  let darkMode: string;
  let csv: string;
  let run: string;
  let sha: string;
  /** A post of mine's board that no release suggests. */
  let darkTheme: string;
  /** Another workspace's board and its waiting run. */
  let theirs: Shop;
  let theirRun: string;

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

  const decideArgs = () => ({ boardId: mine.boardId, runId: run });
  const statusOf = async (postId: string) =>
    expectOne(await t.db.select().from(feedbackPosts).where(eq(feedbackPosts.id, postId))).status;
  const suggestionStates = async (runId: string) => {
    const rows = await t.db.select().from(feedbackShipSuggestions).where(eq(feedbackShipSuggestions.runId, runId));
    return rows.map(row => row.state);
  };

  const person = async (name: string, email: string) =>
    expectOne(await t.db.insert(users).values({ id: randomUUID(), name, email, emailVerified: true }).returning()).id;

  async function addShop(memberId: string): Promise<Shop> {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'member' });
    await project.products.enable(workspaceId, Products.feedback, memberId);
    const { id: projectId } = await project.projects.create(workspaceId, { name: 'Shop', handle: 'shop' });
    const scope = { workspaceId, projectId };
    const repoId = await seedRepo(t.db, workspaceId, 'api', [projectId]);
    const board = await feedback.feedbackBoards.createBoard(scope, memberId, { slug: 'ideas', name: 'Ideas' });
    await feedback.feedbackBoards.setReleasePolicy(scope, memberId, board.id, {
      releaseRepoId: repoId,
      releaseStepName: null,
      shipPolicy: ShipPolicies.allLinksShipped,
      shipMode: ShipModes.suggest,
    });
    return { ...scope, repoId, boardId: board.id };
  }

  async function inProgress(shop: Shop, actor: string, title: string) {
    const created = await feedback.feedbackPosts.create(shop, actor, {
      boardId: shop.boardId,
      title,
      status: FeedbackPostStatuses.inProgress,
    });
    return created.id;
  }

  /** A release of the shop's repo whose commit merged a pull request linked to each post. */
  async function release(shop: Shop, postIds: readonly string[]): Promise<{ runId: string; sha: string }> {
    const released = await seedRun(t.db, { workspaceId: shop.workspaceId, repoId: shop.repoId, finishedAt: now });
    await postIds.reduce(async (previous, postId, index) => {
      await previous;
      const number = index + 1;
      await t.db.insert(feedbackLinks).values({
        workspaceId: shop.workspaceId,
        projectId: shop.projectId,
        postId,
        repoId: shop.repoId,
        kind: FeedbackLinkKinds.pullRequest,
        externalNumber: number,
        externalNodeId: `PR_${randomUUID()}`,
        title: `Pull request ${String(number)}`,
        url: `https://github.com/acme/api/pull/${String(number)}`,
        state: FeedbackLinkStates.merged,
        mergeCommitSha: released.sha,
        mergedAt: now,
      });
    }, Promise.resolve());
    const detector = createShipDetector(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      now: () => now,
    });
    await detector.detect({
      workspaceId: shop.workspaceId,
      runId: released.runId,
      repoId: shop.repoId,
      projectIds: [shop.projectId],
      commitSha: released.sha,
      gateNames: ['production'],
      succeededSteps: ['deploy'],
    });
    return released;
  }

  beforeEach(async () => {
    t = await createTestDb();
    now = new Date('2026-10-17T09:00:00Z');
    feedback = createFeedbackDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      now: () => now,
    });
    project = createProjectDomain(t.db);
    ada = await person('Ada', 'ada@acme.test');
    const eve = await person('Eve', 'eve@acme.test');
    mine = await addShop(ada);
    theirs = await addShop(eve);

    darkMode = await inProgress(mine, ada, 'Dark mode');
    csv = await inProgress(mine, ada, 'Export CSV');
    ({ id: darkTheme } = await feedback.feedbackPosts.create(mine, ada, {
      boardId: mine.boardId,
      title: 'Dark theme',
    }));
    await feedback.feedbackVotes.vote(mine, darkMode, 'ann', { source: FeedbackVoteSources.web });
    ({ runId: run, sha } = await release(mine, [darkMode, csv]));

    const theirPost = await inProgress(theirs, eve, 'Their secret plan');
    ({ runId: theirRun } = await release(theirs, [theirPost]));

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
      feedbackShipSuggestions: feedback.feedbackShipSuggestions,
      feedbackChangelog: feedback.feedbackChangelog,
      feedbackVotes: feedback.feedbackVotes,
      feedbackComments: feedback.feedbackComments,
      feedbackSubscriptions: feedback.feedbackSubscriptions,
      feedbackDuplicates: feedback.feedbackDuplicates,
      feedbackIntake: feedback.feedbackIntake,
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

  describe(LIST, () => {
    it("lists the project's waiting runs with the approver, the posts and the draft, concise unless asked", async () => {
      const concise = bodyOf(await call(LIST, {}));
      expect(concise.projectId).toBe(mine.projectId);
      expect(concise.runs).toEqual([
        {
          boardId: mine.boardId,
          runId: run,
          commitSha: sha,
          approvedBy: ['production'],
          suggestedAt: expect.any(String),
          posts: [
            {
              suggestionId: expect.any(String),
              postId: darkMode,
              number: 1,
              title: 'Dark mode',
              status: FeedbackPostStatuses.inProgress,
              voteCount: 1,
            },
            expect.objectContaining({ postId: csv, number: 2, voteCount: 0 }),
          ],
          changelogEntry: { id: expect.any(String), title: expect.any(String), state: ChangelogEntryStates.draft },
        },
      ]);
      const detailed = bodyOf(await call(LIST, { boardId: mine.boardId, responseFormat: 'detailed' }));
      const [shown] = detailed.runs as Row[];
      expect(shown?.changelogEntry).toMatchObject({
        state: ChangelogEntryStates.draft,
        slug: expect.any(String),
        body: expect.stringContaining('Export CSV'),
        postIds: [darkMode, csv],
      });
    });

    it('shows a merged post, and no runs once decided', async () => {
      await feedback.feedbackMerges.merge(mine, ada, csv, darkTheme);
      const [shown] = bodyOf(await call(LIST, {})).runs as Row[];
      expect((shown?.posts as Row[])[1]).toMatchObject({ postId: csv, mergedIntoPostId: darkTheme });
      await feedback.feedbackShipSuggestions.dismiss(mine, ada, mine.boardId, run);
      expect(bodyOf(await call(LIST, {})).runs).toEqual([]);
    });

    it("refuses another workspace's board exactly as one that does not exist", async () => {
      const nowhere = randomUUID();
      const foreign = await call(LIST, { boardId: theirs.boardId });
      const missing = await call(LIST, { boardId: nowhere });
      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign).replace(theirs.boardId, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(textOf(foreign)).not.toContain('secret');
    });
  });

  describe(ACCEPT, () => {
    it('asks first, naming the run, its approver and each post, and changes nothing until answered', async () => {
      const { asked, requestState } = await ask(ACCEPT, decideArgs());
      const message = messageOf(asked);
      expect(message).toContain('Mark 2 feedback posts shipped');
      expect(message).toContain(`commit ${sha.slice(0, 7)} (approved by production)`);
      expect(message).toContain('#1 "Dark mode": in_progress → shipped (1 vote)');
      expect(message).toContain('#2 "Export CSV": in_progress → shipped (0 votes)');
      expect(message).toContain('stays a draft');
      expect(await statusOf(darkMode)).toBe(FeedbackPostStatuses.inProgress);

      const declined = await answer(ACCEPT, decideArgs(), requestState, false);
      expect(bodyOf(declined)).toMatchObject({ changed: false });
      expect(await suggestionStates(run)).toEqual([ShipSuggestionStates.pending, ShipSuggestionStates.pending]);
    });

    it('marks the posts shipped as the person once confirmed, and it is audited', async () => {
      const accepted = bodyOf(await confirmed(ACCEPT, decideArgs()));
      expect(accepted).toEqual({ accepted: true, runId: run, shipped: 2 });
      expect(await statusOf(darkMode)).toBe(FeedbackPostStatuses.shipped);
      expect(await statusOf(csv)).toBe(FeedbackPostStatuses.shipped);
      const changes = await t.db.select().from(feedbackStatusChanges).where(eq(feedbackStatusChanges.postId, darkMode));
      expect(changes.at(-1)).toMatchObject({
        toStatus: FeedbackPostStatuses.shipped,
        reason: FeedbackStatusChangeReasons.shipSuggestion,
        actorUserId: ada,
      });
      expect(await suggestionStates(run)).toEqual([ShipSuggestionStates.accepted, ShipSuggestionStates.accepted]);
      const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, AuditActions.feedbackShipped));
      expect(new Set(audit.map(row => `${row.subjectId}:${String(row.actorUserId)}`))).toEqual(
        new Set([`${darkMode}:${ada}`, `${csv}:${ada}`]),
      );
    });

    it("refuses an answer once a post's status moved since, and asks again with the new one", async () => {
      const { requestState } = await ask(ACCEPT, decideArgs());
      await feedback.feedbackPosts.setStatus(mine, ada, csv, FeedbackPostStatuses.planned);
      const stale = await answer(ACCEPT, decideArgs(), requestState);
      expect(textOf(stale)).toContain('different change');
      expect(await statusOf(darkMode)).toBe(FeedbackPostStatuses.inProgress);
      const { asked } = await ask(ACCEPT, decideArgs());
      expect(messageOf(asked)).toContain('#2 "Export CSV": planned → shipped');
    });

    it('refuses an answer once the run was decided elsewhere, without asking again', async () => {
      const { requestState } = await ask(ACCEPT, decideArgs());
      await feedback.feedbackShipSuggestions.dismiss(mine, ada, mine.boardId, run);
      const stale = await answer(ACCEPT, decideArgs(), requestState);
      expectRefused(stale);
      expect(textOf(stale)).toContain('No ship suggestions');
      expect(await statusOf(darkMode)).toBe(FeedbackPostStatuses.inProgress);
    });

    it('leaves a merged post as it is, and refuses before asking when every post was merged', async () => {
      await feedback.feedbackMerges.merge(mine, ada, csv, darkTheme);
      const { asked } = await ask(ACCEPT, decideArgs());
      expect(messageOf(asked)).toContain('Mark 1 feedback post shipped');
      expect(messageOf(asked)).toContain(`#2 "Export CSV": merged into ${darkTheme}, left as it is`);

      await feedback.feedbackMerges.merge(mine, ada, darkMode, darkTheme);
      const nothing = await call(ACCEPT, decideArgs(), WRITE);
      expectRefused(nothing);
      expect(textOf(nothing)).toContain('Dismiss');
      expect(await suggestionStates(run)).toEqual([ShipSuggestionStates.pending, ShipSuggestionStates.pending]);
    });

    it("refuses another workspace's board or run, and an unknown run, before asking", async () => {
      const cases = [
        { boardId: theirs.boardId, runId: theirRun },
        { boardId: mine.boardId, runId: theirRun },
        { boardId: mine.boardId, runId: randomUUID() },
      ];
      const answers = await cases.reduce<Promise<RpcAnswer[]>>(async (previous, each) => {
        const done = await previous;
        return [...done, await call(ACCEPT, each, WRITE)];
      }, Promise.resolve([]));
      expect(answers.map(each => [each.result?.isError, each.result?.resultType === 'input_required'])).toEqual([
        [true, false],
        [true, false],
        [true, false],
      ]);
      expect(answers.map(each => textOf(each)).join('\n')).not.toContain('secret');
      expect(await suggestionStates(theirRun)).toEqual([ShipSuggestionStates.pending]);
    });
  });

  describe(DISMISS, () => {
    it('asks first, then sets the run aside as the person, leaving the posts as they are', async () => {
      const { asked } = await ask(DISMISS, decideArgs());
      expect(messageOf(asked)).toContain('Dismiss the ship suggestions for 2 feedback posts');
      expect(messageOf(asked)).toContain('#1 "Dark mode": stays in_progress');
      expect(await suggestionStates(run)).toEqual([ShipSuggestionStates.pending, ShipSuggestionStates.pending]);

      const dismissed = bodyOf(await confirmed(DISMISS, decideArgs()));
      expect(dismissed).toEqual({ dismissed: true, runId: run, suggestions: 2 });
      expect(await statusOf(darkMode)).toBe(FeedbackPostStatuses.inProgress);
      const rows = await t.db.select().from(feedbackShipSuggestions).where(eq(feedbackShipSuggestions.runId, run));
      expect(rows.map(row => [row.state, row.decidedByUserId])).toEqual([
        [ShipSuggestionStates.dismissed, ada],
        [ShipSuggestionStates.dismissed, ada],
      ]);
    });

    it('refuses an answer once a post was merged since, and a run with nothing waiting before asking', async () => {
      const { requestState } = await ask(DISMISS, decideArgs());
      await feedback.feedbackMerges.merge(mine, ada, csv, darkTheme);
      const stale = await answer(DISMISS, decideArgs(), requestState);
      expect(textOf(stale)).toContain('different change');
      await feedback.feedbackShipSuggestions.accept(mine, ada, mine.boardId, run);
      expectRefused(await call(DISMISS, decideArgs(), WRITE));
    });
  });

  describe('locks', () => {
    const tools = [ACCEPT, DISMISS];

    it('challenges a token without feedback:write for it, keeping the scopes it has', async () => {
      await tools.reduce(async (previous, tool) => {
        await previous;
        const challenged = await call(tool, decideArgs());
        expect(challenged.status, tool).toBe(403);
        expect(challenged.wwwAuthenticate).toContain('insufficient_scope');
        expect(challenged.wwwAuthenticate).toContain('feedback:write');
        expect(challenged.wwwAuthenticate).toContain('openid');
      }, Promise.resolve());
    });

    it('refuses where the workspace has not allowed agents to make changes, and says where to change it', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);
      await tools.reduce(async (previous, tool) => {
        await previous;
        const refusal = await call(tool, decideArgs(), WRITE);
        expect(refusal.result?.isError, tool).toBe(true);
        expect(textOf(refusal)).toContain('Settings → Agents');
      }, Promise.resolve());
      expect(await suggestionStates(run)).toEqual([ShipSuggestionStates.pending, ShipSuggestionStates.pending]);
    });
  });

  it('marks the read read-only and the decisions as changes', async () => {
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
    expect(hintsOf(LIST)).toMatchObject({ readOnlyHint: true });
    expect(hintsOf(ACCEPT)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hintsOf(DISMISS)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
