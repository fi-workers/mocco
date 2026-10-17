// The help center's editor over MCP, over a real database, through the real HTTP handler:
// `mocco_help_site_get`, `_drafts_list`, `_draft_get` and `_revisions_list` read what the
// console's editor shows, and the writing tools (`help-authoring-write.ts`) change it.
//
// The changes have every lock a changing tool has (`help:write`, the workspace's opt-in, a
// confirmation naming exactly what would change), write nothing until the person says yes,
// refuse an answer once the state it was asked about has moved (a draft edited since, a section
// that has another article), and apply a confirmation answered twice once.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { Products } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { FakeTranslator } from '@backend/domain/helpcenter/translate/testing/fake-translator';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { auditLog, members, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { HelpAuthoringTools } from '@backend/transport/mcp/tools/help-authoring-write';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';
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
  throw new Error('the help authoring tools must not reach another domain');
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
    tools?: { name: string; annotations?: Record<string, boolean> }[];
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
const WRITE = [...SIGN_IN, 'help:write'];
const T = HelpAuthoringTools;

const BODY = '## Add the widget\n\nTap [here](https://a.test).';
const ELEVEN_MINUTES = 11 * 60 * 1000;
const LONG = `# Long\n\n${'Words and more words. '.repeat(60)}`;

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

interface Scope {
  workspaceId: string;
  projectId: string;
}

describe('mocco_help authoring tools (pglite, over HTTP)', () => {
  let t: TestDb;
  let help: HelpDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let ada: string;
  let mine: Scope;
  /** A second project in Ada's workspace, with no help center yet. */
  let bare: Scope;
  let theirs: Scope;
  let collectionId: string;
  let sectionId: string;
  /** Published, then edited: its draft differs from what is published. */
  let widget: { id: string; shortId: string };
  /** Never published, with a long body. */
  let notes: { id: string; shortId: string };
  let theirArticle: string;
  let ticks: number;

  async function call(tool: string, args: Record<string, unknown>, scopes = SIGN_IN, round: Round = {}) {
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
          extra: { [MCP_USER_ID]: ada },
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

  /** A read in Ada's help center. */
  const read = async (tool: string, args: Record<string, unknown> = {}) => await call(tool, { ...mine, ...args });

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

  const auditedAs = async (action: string) => {
    const rows = await t.db.select().from(auditLog);
    return rows.filter(row => row.action === action).map(row => row.actorUserId);
  };

  const articleOf = async (articleId: string) =>
    await help.helpAuthoring.article(mine.workspaceId, mine.projectId, articleId);

  const sectionArticles = async () => {
    const tree = await help.helpAuthoring.tree(mine.workspaceId, mine.projectId);
    return tree.flatMap(collection => collection.sections).find(section => section.id === sectionId)?.articles ?? [];
  };

  /** Each change with arguments it would ask about. */
  const changes = (): [string, Record<string, unknown>][] => [
    [T.siteEnable, { ...bare, slug: `b${randomUUID().slice(0, 8)}`, sourceLocale: 'en' }],
    [T.collectionCreate, { ...mine, title: 'More', slug: 'more' }],
    [T.sectionCreate, { ...mine, collectionId, title: 'Advanced' }],
    [T.articleCreate, { ...mine, sectionId, title: 'New one' }],
    [T.draftSave, { ...mine, articleId: notes.shortId, title: 'Notes', body: 'Changed.' }],
    [T.articlePublish, { ...mine, articleId: notes.shortId }],
    [T.articleUnpublish, { ...mine, articleId: widget.shortId }],
    [T.articleDelete, { ...mine, articleId: notes.shortId }],
  ];

  const person = async (name: string) =>
    expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name, email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;

  async function addWorkspace(memberId: string): Promise<Scope> {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'member' });
    await project.products.enable(workspaceId, Products.helpcenter, memberId);
    const created = await project.projects.create(workspaceId, { name: 'ShowYourTime', handle: 'syt' });
    return { workspaceId, projectId: created.id };
  }

  /** A help site in `scope` with one collection and section; `write` adds an article to it. */
  async function site(scope: Scope, authorId: string) {
    const { workspaceId, projectId } = scope;
    await help.helpSites.enable(workspaceId, projectId, authorId, {
      slug: `s${randomUUID().slice(0, 8)}`,
      sourceLocale: 'en',
      locales: ['ko'],
    });
    const collection = await help.helpAuthoring.createCollection(workspaceId, projectId, {
      title: 'Start',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, projectId, {
      collectionId: collection.id,
      title: 'Basics',
    });
    const write = async (title: string, body: string, isPublished: boolean) => {
      const article = await help.helpAuthoring.createArticle(workspaceId, projectId, authorId, {
        sectionId: section.id,
        title,
      });
      await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, { articleId: article.id, title, body });
      if (isPublished) {
        await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
      }
      return { id: article.id, shortId: article.shortId };
    };
    return { collectionId: collection.id, sectionId: section.id, write };
  }

  beforeEach(async () => {
    t = await createTestDb();
    ticks = 0;
    help = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      translator: new FakeTranslator(),
      queue: {
        enqueue: async () => await Promise.resolve({ job: { id: randomUUID() } as never, created: true }),
        kick: () => {},
      },
      // A clock that moves past the editing session at every read, so each save is its own revision.
      now: () => {
        ticks += 1;
        return new Date(Date.UTC(2026, 9, 1) + ticks * ELEVEN_MINUTES);
      },
    });
    project = createProjectDomain(t.db);
    ada = await person('Ada');
    const eve = await person('Eve');
    mine = await addWorkspace(ada);
    const second = await project.projects.create(mine.workspaceId, { name: 'Bare', handle: 'bare' });
    bare = { workspaceId: mine.workspaceId, projectId: second.id };
    theirs = await addWorkspace(eve);

    const built = await site(mine, ada);
    ({ collectionId, sectionId } = built);
    widget = await built.write('Widget', BODY, true);
    await help.helpAuthoring.saveDraft(mine.workspaceId, mine.projectId, ada, {
      articleId: widget.id,
      title: 'Widget',
      body: `${BODY}\n\nEdited.`,
    });
    notes = await built.write('Release notes', LONG, false);

    const theirSite = await site(theirs, eve);
    ({ shortId: theirArticle } = await theirSite.write('Their secret widget', 'Shh.', true));

    settings = createMcpSettingsService(t.db, new AuditService({ audit: new AuditRepo(t.db) }));
    await settings.setAgentsMayDecide(mine.workspaceId, true, ada);
    await settings.setAgentsMayDecide(theirs.workspaceId, true, eve);

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
      helpPublic: help.helpPublic,
      helpFeedback: help.helpFeedback,
      helpTranslations: help.helpTranslations,
      helpGlossary: help.helpGlossary,
      helpSites: help.helpSites,
      helpAuthoring: help.helpAuthoring,
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

  describe('reads', () => {
    it('reads the site with its collections, sections and article counts, and says when there is none', async () => {
      const read1 = bodyOf(await read('mocco_help_site_get'));
      const none = bodyOf(await call('mocco_help_site_get', { ...bare }));

      expect(read1).toMatchObject({
        site: { sourceLocale: 'en', locales: ['ko'] },
        collections: [
          {
            id: collectionId,
            slug: 'start',
            sections: [{ id: sectionId, title: 'Basics', articles: 2, published: 1 }],
          },
        ],
      });
      expect(none).toMatchObject({ site: null });
      expect(String(none.reason)).toContain(T.siteEnable);
    });

    it('lists drafts and published articles, filtered and paged, concise or detailed', async () => {
      const all = bodyOf(await read('mocco_help_drafts_list'));
      const drafts = bodyOf(await read('mocco_help_drafts_list', { status: 'draft' }));
      const changed = bodyOf(await read('mocco_help_drafts_list', { hasUnpublishedChanges: true }));
      const found = bodyOf(
        await read('mocco_help_drafts_list', { query: 'RELEASE', responseFormat: 'detailed', limit: 1 }),
      );
      const paged = bodyOf(await read('mocco_help_drafts_list', { limit: 1 }));

      expect(all).toEqual({
        total: 2,
        articles: [
          { id: widget.shortId, title: 'Widget', status: 'published', hasUnpublishedChanges: true },
          { id: notes.shortId, title: 'Release notes', status: 'draft', hasUnpublishedChanges: true },
        ],
      });
      expect(drafts).toMatchObject({ total: 1, articles: [{ id: notes.shortId }] });
      expect(changed).toMatchObject({ total: 2 });
      expect(found).toMatchObject({
        total: 1,
        articles: [{ id: notes.shortId, collection: { id: collectionId }, section: { id: sectionId } }],
      });
      expect(paged).toMatchObject({ total: 2, nextOffset: 1 });
    });

    it('reads a draft concise (an excerpt) or detailed (the whole Markdown), with its revisions', async () => {
      const concise = bodyOf(await read('mocco_help_draft_get', { articleId: notes.shortId }));
      const detailed = bodyOf(
        await read('mocco_help_draft_get', { articleId: `${widget.shortId}-widget`, responseFormat: 'detailed' }),
      );
      const article = await articleOf(widget.id);

      expect(concise).toMatchObject({ status: 'draft', published: null, draft: { isTruncated: true } });
      expect((concise.draft as Row).body).not.toBe(LONG);
      expect(detailed).toMatchObject({
        id: widget.shortId,
        status: 'published',
        hasUnpublishedChanges: true,
        draft: { revisionId: article.draft?.id, body: `${BODY}\n\nEdited.` },
        published: { revisionId: article.published?.id, title: 'Widget' },
      });
    });

    it('lists the history, marking the draft and the published text, and reads one revision whole', async () => {
      const listed = bodyOf(await read('mocco_help_revisions_list', { articleId: widget.shortId }));
      const revisions = listed.revisions as Row[];
      const published = revisions.find(each => each.isPublished === true);
      const one = bodyOf(
        await read('mocco_help_revisions_list', { articleId: widget.shortId, revisionId: published?.revisionId }),
      );

      expect(revisions).toHaveLength(Number(listed.total));
      expect(revisions.filter(each => each.isDraft === true)).toHaveLength(1);
      expect(published).toBeDefined();
      expect(one).toMatchObject({ revision: { revisionId: published?.revisionId, body: BODY } });
    });

    it("never reads another workspace's help center, by its workspace or by its article id", async () => {
      const answers = await Promise.all([
        call('mocco_help_drafts_list', { ...theirs }),
        call('mocco_help_draft_get', { ...mine, articleId: theirArticle }),
        call('mocco_help_revisions_list', { ...mine, articleId: theirArticle }),
      ]);

      expect(answers.map(each => each.result?.isError)).toEqual([true, true, true]);
      expect(answers.map(each => textOf(each)).join(' ')).not.toMatch(/secret/iu);
    });
  });

  describe(T.siteEnable, () => {
    it('asks, then sets up a help center as the person; one that exists is left as it is without asking', async () => {
      const args = { ...bare, slug: 'bare-help', sourceLocale: 'en', locales: ['ko', 'ja'] };
      const { asked, requestState } = await ask(T.siteEnable, args);
      expect(messageOf(asked)).toContain('at the address "bare-help"');
      expect(messageOf(asked)).toContain('into: ko, ja');
      expect(await help.helpSites.get(bare.workspaceId, bare.projectId)).toBeUndefined();

      const done = bodyOf(await answer(T.siteEnable, args, requestState));
      const again = await call(T.siteEnable, args, WRITE, { requestState, inputResponses: accepting(true) });

      expect(done).toMatchObject({ changed: true, slug: 'bare-help', locales: ['ko', 'ja'] });
      expect(bodyOf(again)).toMatchObject({ changed: false, slug: 'bare-help' });
      const rows = await t.db.select().from(auditLog);
      const enabled = rows.filter(
        row => row.action === AuditActions.helpSiteEnabled && row.subjectId === bare.projectId,
      );
      expect(enabled.map(row => row.actorUserId)).toEqual([ada]);
    });

    it('refuses settings the console would refuse before asking', async () => {
      const refused = await call(T.siteEnable, { ...bare, slug: 'x', sourceLocale: 'en', locales: ['en'] }, WRITE);

      expect(refused.result?.isError).toBe(true);
      expect(refused.result?.resultType).not.toBe('input_required');
      expect(textOf(refused)).toContain('source language');
    });
  });

  describe('collections and sections', () => {
    it('adds a collection once, however often the confirmation is answered', async () => {
      const args = { ...mine, title: 'Billing', slug: 'billing', description: 'Plans and invoices' };
      const { asked, requestState } = await ask(T.collectionCreate, args);
      expect(messageOf(asked)).toContain('Add the collection "Billing" at "billing"');

      const round = { requestState, inputResponses: accepting(true) };
      const first = await call(T.collectionCreate, args, WRITE, round);
      const again = await call(T.collectionCreate, args, WRITE, round);

      expect(bodyOf(first)).toMatchObject({ changed: true, collection: { slug: 'billing', title: 'Billing' } });
      expect(bodyOf(again)).toMatchObject({ changed: false });
      const tree = await help.helpAuthoring.tree(mine.workspaceId, mine.projectId);
      expect(tree.map(collection => collection.slug)).toEqual(['start', 'billing']);
    });

    it('adds a section once: a second answer is for a collection that has changed', async () => {
      const args = { ...mine, collectionId, title: 'Advanced' };
      const { asked, requestState } = await ask(T.sectionCreate, args);
      expect(messageOf(asked)).toContain('Add the section "Advanced" to the collection "Start"');

      const round = { requestState, inputResponses: accepting(true) };
      const first = await call(T.sectionCreate, args, WRITE, round);
      const again = await call(T.sectionCreate, args, WRITE, round);

      expect(bodyOf(first)).toMatchObject({ changed: true, section: { title: 'Advanced', collectionId } });
      expect(textOf(again)).toContain('different change');
      const tree = await help.helpAuthoring.tree(mine.workspaceId, mine.projectId);
      expect(tree[0]?.sections.map(section => section.title)).toEqual(['Basics', 'Advanced']);
    });

    it('refuses a collection or section that is not in this help center before asking', async () => {
      const answers = await Promise.all([
        call(T.sectionCreate, { ...mine, collectionId: randomUUID(), title: 'X' }, WRITE),
        call(T.articleCreate, { ...mine, sectionId: randomUUID(), title: 'X' }, WRITE),
      ]);

      expect(answers.map(each => [each.result?.isError, each.result?.resultType === 'input_required'])).toEqual([
        [true, false],
        [true, false],
      ]);
    });
  });

  describe(T.articleCreate, () => {
    it('creates an unpublished draft with its Markdown once, as the person', async () => {
      const args = { ...mine, sectionId, title: 'Pairing', slug: 'pair-a-device', body: '## Pair\n\nHold the button.' };
      const { asked, requestState } = await ask(T.articleCreate, args);
      expect(messageOf(asked)).toContain('Create the article "Pairing" in Start › Basics as a draft');
      expect(messageOf(asked)).toContain('Hold the button.');
      expect(await sectionArticles()).toHaveLength(2);

      const round = { requestState, inputResponses: accepting(true) };
      const created = bodyOf(await call(T.articleCreate, args, WRITE, round));
      const again = await call(T.articleCreate, args, WRITE, round);

      expect(created).toMatchObject({
        created: true,
        slug: 'pair-a-device',
        status: 'draft',
        publishedRevisionId: null,
      });
      expect(textOf(again)).toContain('different change');
      const articles = await sectionArticles();
      expect(articles).toHaveLength(3);
      const article = await articleOf(articles[2]?.id ?? '');
      expect(article.draft).toMatchObject({ title: 'Pairing', body: '## Pair\n\nHold the button.', authorUserId: ada });
    });
  });

  describe(T.draftSave, () => {
    it('says what changes and saves the draft as the person, leaving the published text', async () => {
      const args = { ...mine, articleId: widget.shortId, title: 'Widget', body: 'Rewritten.' };
      const { asked, requestState } = await ask(T.draftSave, args);
      expect(messageOf(asked)).toContain(`Save a new draft of article ${widget.shortId} "Widget"`);
      expect(messageOf(asked)).toContain('After: "Widget", 10 characters');
      expect(messageOf(asked)).toContain('keeps the published text');
      const declined = await answer(T.draftSave, args, requestState, false);
      expect(bodyOf(declined)).toMatchObject({ changed: false });

      const saved = bodyOf(await confirmed(T.draftSave, args));
      const same = await call(T.draftSave, args, WRITE);

      expect(saved).toMatchObject({ changed: true, status: 'published' });
      const article = await articleOf(widget.id);
      expect(article.draft).toMatchObject({ body: 'Rewritten.', authorUserId: ada });
      expect(article.published?.body).toBe(BODY);
      expect(same.result?.resultType).not.toBe('input_required');
      expect(bodyOf(same)).toMatchObject({ changed: false });
    });

    it('refuses a confirmation once the draft was edited since, keeping that edit', async () => {
      const args = { ...mine, articleId: widget.shortId, title: 'Widget', body: 'From the agent.' };
      const { requestState } = await ask(T.draftSave, args);
      await help.helpAuthoring.saveDraft(mine.workspaceId, mine.projectId, ada, {
        articleId: widget.id,
        title: 'Widget',
        body: 'From the console.',
      });

      const stale = await answer(T.draftSave, args, requestState);

      expect(textOf(stale)).toContain('different change');
      const kept = await articleOf(widget.id);
      expect(kept.draft?.body).toBe('From the console.');
    });

    it('refuses an answer that carries a different text from the one confirmed', async () => {
      const args = { ...mine, articleId: widget.shortId, title: 'Widget', body: 'Shown.' };
      const { requestState } = await ask(T.draftSave, args);

      const swapped = await answer(T.draftSave, { ...args, body: 'Swapped.' }, requestState);

      expect(textOf(swapped)).toContain('different change');
      const untouched = await articleOf(widget.id);
      expect(untouched.draft?.body).toBe(`${BODY}\n\nEdited.`);
    });
  });

  describe(T.draftRestore, () => {
    it('makes the published revision the draft again as a new revision', async () => {
      const before = await articleOf(widget.id);
      const args = { ...mine, articleId: widget.shortId, revisionId: before.published?.id };
      const { asked } = await ask(T.draftRestore, args);
      expect(messageOf(asked)).toContain('its draft again');

      const restored = bodyOf(await confirmed(T.draftRestore, args));

      const after = await articleOf(widget.id);
      expect(restored).toMatchObject({ changed: true, restoredFrom: before.published?.id });
      expect(after.draft).toMatchObject({ body: BODY, kind: 'restore' });
      expect(after.draft?.id).not.toBe(before.published?.id);
    });

    it('refuses a revision that is not in the article’s history before asking', async () => {
      const other = await articleOf(notes.id);
      const refused = await call(
        T.draftRestore,
        { ...mine, articleId: widget.shortId, revisionId: other.draft?.id },
        WRITE,
      );

      expect(refused.result?.isError).toBe(true);
      expect(refused.result?.resultType).not.toBe('input_required');
      expect(textOf(refused)).toContain('not in the history');
    });
  });

  describe('publishing', () => {
    it('publishes the draft shown, as the person, and leaves a published draft as it is', async () => {
      const args = { ...mine, articleId: notes.shortId };
      const { asked } = await ask(T.articlePublish, args);
      expect(messageOf(asked)).toContain(`Publish article ${notes.shortId} "Release notes"`);
      expect(messageOf(asked)).toContain('It becomes public.');

      const published = bodyOf(await confirmed(T.articlePublish, args));
      const again = await call(T.articlePublish, args, WRITE);

      expect(published).toMatchObject({ changed: true, status: 'published' });
      expect(bodyOf(again)).toMatchObject({ changed: false });
      expect(await auditedAs(AuditActions.helpArticlePublished)).toContain(ada);
      const article = await articleOf(notes.id);
      expect(article.published?.id).toBe(article.draft?.id);
    });

    it('refuses to publish a draft edited since it was shown', async () => {
      const args = { ...mine, articleId: widget.shortId };
      const { asked, requestState } = await ask(T.articlePublish, args);
      expect(messageOf(asked)).toContain('replaces the text readers see now');
      await help.helpAuthoring.saveDraft(mine.workspaceId, mine.projectId, ada, {
        articleId: widget.id,
        title: 'Widget',
        body: 'Not reviewed yet.',
      });

      const stale = await answer(T.articlePublish, args, requestState);

      expect(textOf(stale)).toContain('different change');
      const live = await articleOf(widget.id);
      expect(live.published?.body).toBe(BODY);
    });

    it('takes an article off the site as the person, and says so for one that is not on it', async () => {
      const unpublished = bodyOf(await confirmed(T.articleUnpublish, { ...mine, articleId: widget.shortId }));
      const notOn = await call(T.articleUnpublish, { ...mine, articleId: notes.shortId }, WRITE);

      expect(unpublished).toMatchObject({ changed: true, status: 'draft' });
      expect(await auditedAs(AuditActions.helpArticleUnpublished)).toEqual([ada]);
      expect(notOn.result?.resultType).not.toBe('input_required');
      expect(bodyOf(notOn)).toMatchObject({ changed: false, status: 'draft' });
    });
  });

  describe(T.articleDelete, () => {
    it('asks, naming what is lost, deletes as the person once confirmed, and only once', async () => {
      const args = { ...mine, articleId: widget.shortId };
      const { asked, requestState } = await ask(T.articleDelete, args);
      expect(messageOf(asked)).toContain(`Delete article ${widget.shortId} "Widget" from Start › Basics for good`);
      expect(messageOf(asked)).toContain('It is published');
      const declined = await answer(T.articleDelete, args, requestState, false);
      expect(bodyOf(declined)).toMatchObject({ changed: false });
      expect(await sectionArticles()).toHaveLength(2);

      const round = { requestState, inputResponses: accepting(true) };
      const deleted = bodyOf(await call(T.articleDelete, args, WRITE, round));
      const again = await call(T.articleDelete, args, WRITE, round);

      expect(deleted).toMatchObject({ changed: true, deleted: true, id: widget.shortId });
      expect(again.result?.isError).toBe(true);
      expect(await sectionArticles()).toHaveLength(1);
      expect(await auditedAs(AuditActions.helpArticleDeleted)).toEqual([ada]);
    });
  });

  describe('locks', () => {
    it('challenges a token without help:write for it, keeping the scopes it has', async () => {
      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const challenged = await call(tool, args, [...SIGN_IN, 'feedback:write']);
        expect(challenged.status, tool).toBe(403);
        expect(challenged.wwwAuthenticate).toContain('help:write');
        expect(challenged.wwwAuthenticate).toContain('feedback:write');
      }, Promise.resolve());
    });

    it('refuses where the workspace has not allowed agents to make changes, and says where to change it', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);

      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const refused = await call(tool, args, WRITE);
        expect(refused.result?.isError, tool).toBe(true);
        expect(refused.result?.resultType).not.toBe('input_required');
        expect(textOf(refused)).toContain('Settings → Agents');
      }, Promise.resolve());
      expect(await sectionArticles()).toHaveLength(2);
    });

    it("never reaches another workspace's help center, by its workspace or by its article id", async () => {
      const foreign: [string, Record<string, unknown>][] = [
        [T.collectionCreate, { ...theirs, title: 'X', slug: 'x' }],
        [T.draftSave, { ...theirs, articleId: theirArticle, title: 'X', body: 'X' }],
        [T.articleUnpublish, { ...theirs, articleId: theirArticle }],
        [T.articleDelete, { ...mine, articleId: theirArticle }],
        [T.articlePublish, { ...mine, articleId: theirArticle }],
      ];
      const answers = await foreign.reduce<Promise<RpcAnswer[]>>(async (previous, [tool, args]) => {
        const done = await previous;
        return [...done, await call(tool, args, WRITE)];
      }, Promise.resolve([]));

      expect(answers.map(each => [each.result?.isError, each.result?.resultType === 'input_required'])).toEqual(
        foreign.map(() => [true, false]),
      );
      expect(answers.map(each => textOf(each)).join(' ')).not.toMatch(/secret/iu);
      const theirTree = await help.helpAuthoring.tree(theirs.workspaceId, theirs.projectId);
      expect(theirTree.map(collection => collection.slug)).toEqual(['start']);
    });
  });

  it('marks deleting, publishing and unpublishing as destructive, and the rest as changes', async () => {
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
    const listed = (await response.json()) as RpcAnswer;
    const hintsOf = (name: string) => listed.result?.tools?.find(each => each.name === name)?.annotations;

    expect([T.articleDelete, T.articlePublish, T.articleUnpublish].map(name => hintsOf(name)?.destructiveHint)).toEqual(
      [true, true, true],
    );
    expect(
      [T.siteEnable, T.collectionCreate, T.sectionCreate, T.articleCreate, T.draftSave, T.draftRestore].map(name =>
        hintsOf(name),
      ),
    ).toEqual(
      Array.from({ length: 6 }, () => expect.objectContaining({ readOnlyHint: false, destructiveHint: false })),
    );
  });
});
