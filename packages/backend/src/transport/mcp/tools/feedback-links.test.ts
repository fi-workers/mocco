// `mocco_feedback_links_list`, `_github_search`, `_post_link` and `_post_unlink` over a real
// database and a fake IssueTracker, through the real HTTP handler.
//
// The reads stay inside the caller's project and its repos. The two changes have every lock a
// changing tool has (`feedback:write`, the workspace's opt-in, a confirmation naming the post and
// the issue or pull request with its state), write nothing until the person says yes, refuse what
// the service would refuse before asking, and refuse an answer once GitHub says something else.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { FeedbackLinkKinds, FeedbackLinkStates } from '@mocco/common/feedback';
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
import {
  auditLog,
  feedbackLinks,
  members,
  projectRepos,
  providerConnections,
  repos,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { FeedbackDomain } from '@backend/domain/feedback/compose';
import type { IssueTracker, TrackerItem, TrackerPullRequest, TrackerRepoRef } from '@backend/domain/integration/ports';
import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { ProjectDomain } from '@backend/domain/project/instance';
import type { AuditAction } from '@mocco/common/audit';
import type { FeedbackLinkKind } from '@mocco/common/feedback';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the feedback link tools must not reach another domain');
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
const LINKS = 'mocco_feedback_links_list';
const SEARCH = 'mocco_feedback_github_search';
const LINK = 'mocco_feedback_post_link';
const UNLINK = 'mocco_feedback_post_unlink';

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

/** A refusal: an error the model reads, never a question to the person. */
function expectRefused(answer: RpcAnswer): string {
  expect(answer.result?.isError, textOf(answer)).toBe(true);
  expect(answer.result?.resultType).not.toBe('input_required');
  return textOf(answer);
}

interface Scope {
  workspaceId: string;
  projectId: string;
}

const item = (kind: FeedbackLinkKind, number: number, overrides: Partial<TrackerItem> = {}): TrackerItem => ({
  kind,
  number,
  nodeId: `${kind}_${String(number)}`,
  title: `${kind} ${String(number)}`,
  url: `https://github.com/acme/${kind === FeedbackLinkKinds.issue ? 'issues' : 'pull'}/${String(number)}`,
  state: FeedbackLinkStates.open,
  mergeCommitSha: null,
  mergedAt: null,
  ...overrides,
});

/** The IssueTracker port over in-memory issues and pull requests per repo; no GitHub is called. */
class FakeIssueTracker implements IssueTracker {
  private items = new Map<string, TrackerItem[]>();

  readonly closers = new Map<number, TrackerPullRequest[]>();

  put(repo: string, entry: TrackerItem): void {
    const others = (this.items.get(repo) ?? []).filter(
      other => other.kind !== entry.kind || other.number !== entry.number,
    );
    this.items.set(repo, [...others, entry]);
  }

  async search(repo: TrackerRepoRef, kind: FeedbackLinkKind, query: string, limit: number): Promise<TrackerItem[]> {
    // eslint-disable-next-line sonarjs/null-dereference -- `query` is a string, never null
    const words = query.replace('#', '').toLowerCase();
    return await Promise.resolve(
      (this.items.get(repo.name) ?? [])
        .filter(entry => entry.kind === kind)
        .filter(entry => String(entry.number) === words || entry.title.toLowerCase().includes(words))
        .slice(0, limit),
    );
  }

  async get(repo: TrackerRepoRef, kind: FeedbackLinkKind, number: number): Promise<TrackerItem | null> {
    return await Promise.resolve(
      (this.items.get(repo.name) ?? []).find(entry => entry.kind === kind && entry.number === number) ?? null,
    );
  }

  async closingPullRequests(_repo: TrackerRepoRef, issueNumber: number): Promise<TrackerPullRequest[]> {
    return await Promise.resolve(this.closers.get(issueNumber) ?? []);
  }
}

describe('mocco_feedback GitHub links (pglite, fake IssueTracker, over HTTP)', () => {
  let t: TestDb;
  let tracker: FakeIssueTracker;
  let feedback: FeedbackDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let ada: string;
  let mine: Scope;
  /** The project's two repos: `app` and `web`. */
  let app: string;
  let web: string;
  /** A post that links issue #12 of `app` (closed by pull request #42). */
  let darkMode: string;
  let darkModeLink: string;
  /** A post with no links. */
  let csvExport: string;
  /** Another workspace's repo, post and link. */
  let foreignRepo: string;
  let foreignPost: string;
  let foreignLink: string;

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

  const linkArgs = () => ({ postId: csvExport, repoId: web, kind: FeedbackLinkKinds.pullRequest, number: 7 });
  const linksOf = async (postId: string) =>
    await t.db.select().from(feedbackLinks).where(eq(feedbackLinks.postId, postId));
  const auditOf = async (action: AuditAction) => await t.db.select().from(auditLog).where(eq(auditLog.action, action));

  const person = async (name: string, email: string) =>
    expectOne(await t.db.insert(users).values({ id: randomUUID(), name, email, emailVerified: true }).returning()).id;

  async function addWorkspace(memberId: string, login: string): Promise<Scope & { connectionId: string }> {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'member' });
    await project.products.enable(workspaceId, Products.feedback, memberId);
    const created = await project.projects.create(workspaceId, { name: 'Shop', handle: 'shop' });
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: login })
        .returning(),
    );
    return { workspaceId, projectId: created.id, connectionId: connection.id };
  }

  /** A GitHub repo of the workspace, linked to its project. */
  async function addRepo(where: Scope & { connectionId: string }, owner: string, name: string) {
    const repo = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId: where.workspaceId,
          connectionId: where.connectionId,
          externalRepoId: randomUUID(),
          owner,
          name,
          defaultBranch: 'main',
        })
        .returning(),
    );
    await t.db
      .insert(projectRepos)
      .values({ workspaceId: where.workspaceId, projectId: where.projectId, repoId: repo.id });
    return repo.id;
  }

  function build(withTracker: IssueTracker | undefined) {
    const scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    const domain = createFeedbackDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      ...(withTracker !== undefined && { tracker: withTracker }),
    });
    return createMcpHttpHandler({
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
      feedbackBoards: domain.feedbackBoards,
      feedbackPosts: domain.feedbackPosts,
      feedbackVotes: domain.feedbackVotes,
      feedbackComments: domain.feedbackComments,
      feedbackMerges: domain.feedbackMerges,
      feedbackLinks: domain.feedbackLinks,
      scope,
      projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
      settings,
      confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
    });
  }

  beforeEach(async () => {
    t = await createTestDb();
    tracker = new FakeIssueTracker();
    feedback = createFeedbackDomain(t.db, { audit: new AuditService({ audit: new AuditRepo(t.db) }), tracker });
    project = createProjectDomain(t.db);
    ada = await person('Ada', 'ada@acme.test');
    const eve = await person('Eve', 'eve@acme.test');
    const myWorkspace = await addWorkspace(ada, 'acme');
    const theirs = await addWorkspace(eve, 'rival');
    mine = { workspaceId: myWorkspace.workspaceId, projectId: myWorkspace.projectId };
    app = await addRepo(myWorkspace, 'acme', 'app');
    web = await addRepo(myWorkspace, 'acme', 'web');
    foreignRepo = await addRepo(theirs, 'rival', 'secret-repo');

    tracker.put('app', item(FeedbackLinkKinds.issue, 12, { title: 'Dark mode please' }));
    tracker.put('web', item(FeedbackLinkKinds.issue, 3, { title: 'Dark mode on the site' }));
    tracker.put('web', item(FeedbackLinkKinds.pullRequest, 7, { title: 'CSV export' }));
    tracker.put('secret-repo', item(FeedbackLinkKinds.issue, 1, { title: 'Their secret dark plan' }));
    tracker.closers.set(12, [
      {
        number: 42,
        nodeId: 'pr_42',
        title: 'Add dark mode',
        url: 'https://github.com/acme/app/pull/42',
        state: FeedbackLinkStates.merged,
        mergeCommitSha: 'abc1234def',
        mergedAt: new Date('2026-10-16T10:00:00Z'),
      },
    ]);

    const ideas = await feedback.feedbackBoards.createBoard(mine, ada, { slug: 'ideas', name: 'Ideas' });
    ({ id: darkMode } = await feedback.feedbackPosts.create(mine, ada, { boardId: ideas.id, title: 'Dark mode' }));
    ({ id: csvExport } = await feedback.feedbackPosts.create(mine, ada, { boardId: ideas.id, title: 'Export' }));
    ({ id: darkModeLink } = await feedback.feedbackLinks.link(mine, ada, darkMode, {
      repoId: app,
      kind: FeedbackLinkKinds.issue,
      number: 12,
    }));

    const theirScope = { workspaceId: theirs.workspaceId, projectId: theirs.projectId };
    const theirBoard = await feedback.feedbackBoards.createBoard(theirScope, eve, { slug: 'ideas', name: 'Theirs' });
    ({ id: foreignPost } = await feedback.feedbackPosts.create(theirScope, eve, {
      boardId: theirBoard.id,
      title: 'Their secret plan',
    }));
    ({ id: foreignLink } = await feedback.feedbackLinks.link(theirScope, eve, foreignPost, {
      repoId: foreignRepo,
      kind: FeedbackLinkKinds.issue,
      number: 1,
    }));

    settings = createMcpSettingsService(t.db, new AuditService({ audit: new AuditRepo(t.db) }));
    await settings.setAgentsMayDecide(mine.workspaceId, true, ada);
    handler = build(tracker);
  });
  afterEach(async () => {
    await t.close();
  });

  describe('reads', () => {
    it("lists a post's links with state, merge commit and closing pull requests, concise unless asked", async () => {
      const concise = bodyOf(await call(LINKS, { postId: darkMode }));
      expect(concise.links).toEqual([
        {
          id: darkModeLink,
          repo: 'acme/app',
          kind: FeedbackLinkKinds.issue,
          number: 12,
          title: 'Dark mode please',
          state: FeedbackLinkStates.open,
          mergeCommitSha: null,
          closers: [
            { number: 42, title: 'Add dark mode', state: FeedbackLinkStates.merged, mergeCommitSha: 'abc1234def' },
          ],
        },
      ]);
      const detailed = bodyOf(await call(LINKS, { postId: darkMode, responseFormat: 'detailed' }));
      expect(detailed.links).toEqual([
        expect.objectContaining({
          repoId: app,
          url: 'https://github.com/acme/issues/12',
          createdByUserId: ada,
          closers: [expect.objectContaining({ url: 'https://github.com/acme/app/pull/42' })],
        }),
      ]);
      expect(bodyOf(await call(LINKS, { postId: csvExport })).links).toEqual([]);
    });

    it("searches every repo the project links, or one, and never another workspace's", async () => {
      const everywhere = bodyOf(await call(SEARCH, { query: 'dark', kind: FeedbackLinkKinds.issue }));
      expect(everywhere.repos).toEqual([
        { id: app, name: 'acme/app' },
        { id: web, name: 'acme/web' },
      ]);
      expect((everywhere.results as Row[]).map(row => [row.repo, row.number, row.state])).toEqual([
        ['acme/app', 12, FeedbackLinkStates.open],
        ['acme/web', 3, FeedbackLinkStates.open],
      ]);
      expect(JSON.stringify(everywhere)).not.toContain('secret');

      const one = bodyOf(
        await call(SEARCH, {
          query: '#7',
          kind: FeedbackLinkKinds.pullRequest,
          repoId: web,
          responseFormat: 'detailed',
        }),
      );
      expect(one.results).toEqual([expect.objectContaining({ repoId: web, number: 7, url: expect.any(String) })]);

      const theirs = await call(SEARCH, { query: 'dark', kind: FeedbackLinkKinds.issue, repoId: foreignRepo });
      const nowhere = randomUUID();
      const missing = await call(SEARCH, { query: 'dark', kind: FeedbackLinkKinds.issue, repoId: nowhere });
      expect(expectRefused(theirs).replace(foreignRepo, '<id>')).toBe(expectRefused(missing).replace(nowhere, '<id>'));
    });

    it('says clearly when the project links no repo, or the server has no GitHub App', async () => {
      const bare = await project.projects.create(mine.workspaceId, { name: 'Blog', handle: 'blog' });
      const noRepos = await call(SEARCH, { query: 'dark', kind: FeedbackLinkKinds.issue, projectId: bare.id });
      expect(expectRefused(noRepos)).toContain('links no GitHub repository');

      handler = build(undefined);
      const noApp = await call(SEARCH, { query: 'dark', kind: FeedbackLinkKinds.issue, ...mine });
      expect(expectRefused(noApp)).toContain('GitHub is not set up on this server');
      // Existing links still list without it.
      expect(bodyOf(await call(LINKS, { postId: darkMode, ...mine })).links).toHaveLength(1);
    });

    it("refuses another workspace's post exactly as one that does not exist", async () => {
      const nowhere = randomUUID();
      const theirs = await call(LINKS, { postId: foreignPost });
      const missing = await call(LINKS, { postId: nowhere });
      expect(expectRefused(theirs).replace(foreignPost, '<id>')).toBe(expectRefused(missing).replace(nowhere, '<id>'));
      expect(textOf(theirs)).not.toContain('secret');
    });
  });

  describe(LINK, () => {
    it('asks first, naming the post, the repo and the pull request with its state, and links nothing until answered', async () => {
      const { asked } = await ask(LINK, linkArgs());
      expect(messageOf(asked)).toContain('#2 "Export"');
      expect(messageOf(asked)).toContain('pull request #7 of acme/web');
      expect(messageOf(asked)).toContain('"CSV export" (open)');
      expect(await linksOf(csvExport)).toEqual([]);
    });

    it('links as the person once confirmed, and audits it; not when they say no', async () => {
      const { requestState } = await ask(LINK, linkArgs());
      const declined = await answer(LINK, linkArgs(), requestState, false);
      expect(bodyOf(declined)).toMatchObject({ changed: false });
      expect(await linksOf(csvExport)).toEqual([]);

      const linked = bodyOf(await confirmed(LINK, linkArgs()));
      expect(linked).toMatchObject({
        linked: true,
        repo: 'acme/web',
        kind: FeedbackLinkKinds.pullRequest,
        number: 7,
        state: FeedbackLinkStates.open,
      });
      expect(await linksOf(csvExport)).toEqual([
        expect.objectContaining({ id: linked.linkId, createdByUserId: ada, externalNumber: 7 }),
      ]);
      const audit = await auditOf(AuditActions.feedbackPostLinked);
      expect(audit.filter(row => row.subjectId === csvExport).map(row => row.actorUserId)).toEqual([ada]);
    });

    it('refuses an answer once GitHub says the pull request changed state, and asks again with it', async () => {
      const { requestState } = await ask(LINK, linkArgs());
      tracker.put(
        'web',
        item(FeedbackLinkKinds.pullRequest, 7, { title: 'CSV export', state: FeedbackLinkStates.merged }),
      );
      const stale = await answer(LINK, linkArgs(), requestState);
      expect(textOf(stale)).toContain('different change');
      expect(await linksOf(csvExport)).toEqual([]);
      const { asked } = await ask(LINK, linkArgs());
      expect(messageOf(asked)).toContain('(merged)');
    });

    it('refuses before asking: linked already, a missing number, a repo outside the project, a merged post', async () => {
      const already = await call(
        LINK,
        { postId: darkMode, repoId: app, kind: FeedbackLinkKinds.issue, number: 12 },
        WRITE,
      );
      expect(expectRefused(already)).toContain('already linked');
      const missing = await call(LINK, { ...linkArgs(), number: 999 }, WRITE);
      expect(expectRefused(missing)).toContain('no pull request #999');
      const foreign = await call(
        LINK,
        { postId: csvExport, repoId: foreignRepo, kind: FeedbackLinkKinds.issue, number: 1 },
        WRITE,
      );
      expect(expectRefused(foreign)).toContain('not linked to this project');
      const theirPost = await call(
        LINK,
        { postId: foreignPost, repoId: app, kind: FeedbackLinkKinds.issue, number: 12 },
        WRITE,
      );
      expect(expectRefused(theirPost)).toContain('was not found');

      await feedback.feedbackMerges.merge(mine, ada, csvExport, darkMode);
      const merged = await call(LINK, linkArgs(), WRITE);
      expect(expectRefused(merged)).toContain(`merged into ${darkMode}`);
      expect(await linksOf(csvExport)).toEqual([]);
      expect(await linksOf(foreignPost)).toHaveLength(1);
    });
  });

  describe(UNLINK, () => {
    it('asks first, naming the link with its state and the post, then unlinks as the person and audits it', async () => {
      const { asked } = await ask(UNLINK, { linkId: darkModeLink });
      expect(messageOf(asked)).toContain('issue #12 of acme/app from feedback post #1 "Dark mode"');
      expect(messageOf(asked)).toContain('"Dark mode please" (open)');
      expect(await linksOf(darkMode)).toHaveLength(1);

      const unlinked = bodyOf(await confirmed(UNLINK, { linkId: darkModeLink }));
      expect(unlinked).toMatchObject({ unlinked: true, linkId: darkModeLink, postId: darkMode });
      expect(await linksOf(darkMode)).toEqual([]);
      const audit = await auditOf(AuditActions.feedbackPostUnlinked);
      expect(audit.map(row => [row.subjectId, row.actorUserId])).toEqual([[darkMode, ada]]);
    });

    it("refuses an answer once the link's state changed, and an answer after it was unlinked", async () => {
      const { requestState } = await ask(UNLINK, { linkId: darkModeLink });
      await t.db
        .update(feedbackLinks)
        .set({ state: FeedbackLinkStates.closed })
        .where(eq(feedbackLinks.id, darkModeLink));
      const stale = await answer(UNLINK, { linkId: darkModeLink }, requestState);
      expect(textOf(stale)).toContain('different change');
      expect(await linksOf(darkMode)).toHaveLength(1);

      const fresh = await ask(UNLINK, { linkId: darkModeLink });
      await feedback.feedbackLinks.unlink(mine, ada, darkModeLink);
      const gone = await answer(UNLINK, { linkId: darkModeLink }, fresh.requestState);
      expect(expectRefused(gone)).toContain('was not found');
    });

    it("refuses another workspace's link exactly as one that does not exist, before asking", async () => {
      const nowhere = randomUUID();
      const theirs = await call(UNLINK, { linkId: foreignLink }, WRITE);
      const missing = await call(UNLINK, { linkId: nowhere }, WRITE);
      expect(expectRefused(theirs).replace(foreignLink, '<id>')).toBe(expectRefused(missing).replace(nowhere, '<id>'));
      expect(await linksOf(foreignPost)).toHaveLength(1);
    });
  });

  describe('locks', () => {
    const changes: [string, () => Record<string, unknown>][] = [
      [LINK, linkArgs],
      [UNLINK, () => ({ linkId: darkModeLink })],
    ];

    it('challenges a token without feedback:write for it, keeping the scopes it has', async () => {
      await changes.reduce(async (previous, [tool, args]) => {
        await previous;
        const challenged = await call(tool, args());
        expect(challenged.status, tool).toBe(403);
        expect(challenged.wwwAuthenticate).toContain('insufficient_scope');
        expect(challenged.wwwAuthenticate).toContain('feedback:write');
        expect(challenged.wwwAuthenticate).toContain('openid');
      }, Promise.resolve());
    });

    it('refuses where the workspace has not allowed agents to make changes, and says where to change it', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);
      await changes.reduce(async (previous, [tool, args]) => {
        await previous;
        expect(expectRefused(await call(tool, args(), WRITE))).toContain('Settings → Agents');
      }, Promise.resolve());
      expect(await linksOf(csvExport)).toEqual([]);
      expect(await linksOf(darkMode)).toHaveLength(1);
    });
  });

  it('marks the reads read-only, the unlink destructive and the link a change', async () => {
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
    expect(hintsOf(LINKS)).toMatchObject({ readOnlyHint: true });
    expect(hintsOf(SEARCH)).toMatchObject({ readOnlyHint: true });
    expect(hintsOf(LINK)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hintsOf(UNLINK)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
