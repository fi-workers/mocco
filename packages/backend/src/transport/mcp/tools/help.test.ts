// `mocco_help_articles_*` over a real database, through the real HTTP handler.
//
// The reads are only as safe as the scoping in front of them: another workspace's project
// reads like one that does not exist, drafts and unpublished articles are never there,
// and a workspace without the help center product says so.
import { randomUUID } from 'node:crypto';

import { Products } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createHelpDomain } from '@backend/domain/helpcenter/compose';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { helpFeedback, members, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { HelpDomain } from '@backend/domain/helpcenter/compose';
import type { ProjectDomain } from '@backend/domain/project/instance';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const refuse = () => {
  throw new Error('the help tools must not reach another domain');
};

interface RpcAnswer {
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
  };
}

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

function bodyOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Record<string, unknown>;
}

type Row = Record<string, unknown>;

const HELP_TOOLS = [
  'mocco_help_articles_get',
  'mocco_help_articles_search',
  'mocco_help_glossary_list',
  'mocco_help_translation_get',
  'mocco_help_translations_list',
];

describe('mocco_help_articles_* (pglite, over HTTP)', () => {
  let t: TestDb;
  let help: HelpDomain;
  let project: ProjectDomain;
  let handler: McpHttpHandler;
  let ada: string;
  let mine: { workspaceId: string; projectId: string };
  let theirs: { workspaceId: string; projectId: string };
  let widget: string;
  let widgetId: string;
  let camera: string;
  let draft: string;
  let pulled: string;
  let theirArticle: string;

  async function rpc(userId: string, method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
    const name = typeof params.name === 'string' ? params.name : undefined;
    const response = await handler.fetch(
      new Request(RESOURCE, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-method': method,
          ...(name !== undefined && { 'mcp-name': name }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope } }),
      }),
      {
        authInfo: {
          token: '',
          clientId: 'agent',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          resource: new URL(RESOURCE),
          extra: { [MCP_USER_ID]: userId },
        },
      },
    );
    const text = await response.text();
    return (text === '' ? {} : JSON.parse(text)) as RpcAnswer;
  }

  const call = async (tool: string, args: Record<string, unknown>) =>
    await rpc(ada, 'tools/call', { name: tool, arguments: args });

  /** The widget article published again with one sentence changed: its reviewed Korean is stale. */
  const editSource = async () => {
    await help.helpAuthoring.saveDraft(mine.workspaceId, mine.projectId, ada, {
      articleId: widgetId,
      title: 'Add a widget',
      body: `Touch and hold the home screen. ${'More words. '.repeat(80)}`,
    });
    await help.helpAuthoring.publish(mine.workspaceId, mine.projectId, ada, widgetId);
  };

  async function addWorkspace(memberId?: string) {
    const workspaceId = expectOne(
      await t.db
        .insert(workspaces)
        .values({ name: randomUUID().slice(0, 6), slug: randomUUID() })
        .returning(),
    ).id;
    if (memberId !== undefined) {
      await t.db.insert(members).values({ organizationId: workspaceId, userId: memberId, role: 'owner' });
    }
    await project.products.enable(workspaceId, Products.helpcenter, ada);
    const created = await project.projects.create(workspaceId, { name: 'ShowYourTime', handle: 'syt' });
    return { workspaceId, projectId: created.id };
  }

  /** A help site in `scope` with articles under one section; the ids of what was written. */
  async function writeSite(scope: { workspaceId: string; projectId: string }, slug: string) {
    const { workspaceId, projectId } = scope;
    await help.helpSites.enable(workspaceId, projectId, ada, { slug, sourceLocale: 'en', locales: ['ko'] });
    const collection = await help.helpAuthoring.createCollection(workspaceId, projectId, {
      title: 'Getting started',
      slug: 'start',
    });
    const section = await help.helpAuthoring.createSection(workspaceId, projectId, {
      collectionId: collection.id,
      title: 'Basics',
    });
    const write = async (title: string, body: string, isPublished: boolean) => {
      const article = await help.helpAuthoring.createArticle(workspaceId, projectId, ada, {
        sectionId: section.id,
        title,
      });
      await help.helpAuthoring.saveDraft(workspaceId, projectId, ada, { articleId: article.id, title, body });
      if (isPublished) {
        await help.helpAuthoring.publish(workspaceId, projectId, ada, article.id);
      }
      return article;
    };
    return { write };
  }

  beforeEach(async () => {
    t = await createTestDb();
    help = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      feedbackSecret: () => 'test-feedback-secret',
    });
    project = createProjectDomain(t.db);
    ada = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    mine = await addWorkspace(ada);
    theirs = await addWorkspace();

    const { write } = await writeSite(mine, `syt${randomUUID().slice(0, 6)}`);
    const added = await write('Add a widget', `Long-press the home screen. ${'More words. '.repeat(80)}`, true);
    widget = added.shortId;
    widgetId = added.id;
    await help.helpTranslations.saveTranslation(mine.workspaceId, mine.projectId, ada, {
      articleId: added.id,
      locale: 'ko',
      title: '위젯 추가하기',
      body: '홈 화면을 길게 누르세요.',
    });
    ({ shortId: camera } = await write('Camera settings', 'Open the camera and tap the gear.', true));
    ({ shortId: draft } = await write('Upcoming widget', 'Not yet.', false));
    const old = await write('Old widget', 'Gone.', true);
    pulled = old.shortId;
    await help.helpAuthoring.unpublish(mine.workspaceId, mine.projectId, ada, old.id);

    const other = await writeSite(theirs, `oth${randomUUID().slice(0, 6)}`);
    ({ shortId: theirArticle } = await other.write('Their secret widget', 'Shh.', true));
    await help.helpGlossary.importTerms(mine.workspaceId, mine.projectId, ada, [
      { term: 'ShowYourTime', rule: 'keep', note: 'The product name' },
      { term: 'widget', rule: 'fixed', translations: { de: 'Steuerelement' } },
      { term: 'workspace', rule: 'fixed', translations: { de: 'Arbeitsbereich' } },
    ]);
    await help.helpGlossary.addTerm(theirs.workspaceId, theirs.projectId, ada, { term: 'SecretName', rule: 'keep' });

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
      messengerInbox: { list: refuse, get: refuse, write: refuse, assign: refuse, assignable: refuse },
      feedbackBoards: { listBoards: refuse, getBoard: refuse },
      feedbackPosts: { list: refuse, get: refuse, requirePost: refuse, setStatus: refuse },
      feedbackVotes: { list: refuse, find: refuse, vote: refuse },
      feedbackComments: { listForStaff: refuse, createAsStaff: refuse },
      feedbackMerges: { merge: refuse },
      scope,
      projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
      settings: { agentsMayDecide: refuse },
      confirmations: undefined,
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('lists every help tool as read-only', async () => {
    const listed = await rpc(ada, 'tools/list', {});
    const tools = listed.result?.tools?.filter(tool => tool.name.startsWith('mocco_help_')) ?? [];

    expect(new Set(tools.map(tool => tool.name))).toEqual(new Set(HELP_TOOLS));
    expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  describe('mocco_help_articles_search', () => {
    it('finds published articles by text, best first, and lists them all without a query', async () => {
      const found = bodyOf(await call('mocco_help_articles_search', { query: 'widget' }));
      const listed = bodyOf(await call('mocco_help_articles_search', { limit: 1 }));
      const next = bodyOf(await call('mocco_help_articles_search', { limit: 1, after: listed.nextAfter }));

      expect(found).toEqual({
        site: 'ShowYourTime',
        locale: 'en',
        articles: [{ id: widget, title: 'Add a widget', path: `/en/articles/${widget}-add-a-widget` }],
      });
      expect([(listed.articles as Row[])[0]?.id, listed.nextAfter]).toEqual([widget, widget]);
      expect([(next.articles as Row[])[0]?.id, next.nextAfter]).toEqual([camera, undefined]);
    });

    it('answers in a translated language, with collection, section and snippet when detailed', async () => {
      const found = bodyOf(
        await call('mocco_help_articles_search', { query: '위젯', locale: 'ko-KR', responseFormat: 'detailed' }),
      );

      expect(found).toMatchObject({
        locale: 'ko',
        articles: [
          {
            id: widget,
            title: '위젯 추가하기',
            collection: 'Getting started',
            section: 'Basics',
            snippet: '홈 화면을 길게 누르세요.',
          },
        ],
      });
    });

    it('never shows drafts, unpublished articles or another workspace’s help center', async () => {
      const listed = bodyOf(await call('mocco_help_articles_search', { limit: 50 }));
      const searched = bodyOf(await call('mocco_help_articles_search', { query: 'widget', match: 'any' }));
      const foreign = await call('mocco_help_articles_search', { ...theirs, query: 'widget' });

      expect((listed.articles as Row[]).map(each => each.id)).toEqual([widget, camera]);
      expect(JSON.stringify(searched)).not.toMatch(/Upcoming|Old widget|secret/u);
      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).not.toContain('secret');
    });
  });

  describe('mocco_help_translations_*', () => {
    it('counts each language and lists what needs attention, concise or detailed, paged', async () => {
      const before = bodyOf(await call('mocco_help_translations_list', {}));
      await editSource();
      const after = bodyOf(await call('mocco_help_translations_list', {}));
      const page = bodyOf(await call('mocco_help_translations_list', { filter: 'all', limit: 1 }));
      const next = bodyOf(await call('mocco_help_translations_list', { filter: 'all', limit: 1, offset: 1 }));
      const stale = bodyOf(await call('mocco_help_translations_list', { filter: 'stale', responseFormat: 'detailed' }));

      // Drafts and unpublished articles aren't counted: two published articles.
      expect(before).toMatchObject({
        sourceLocale: 'en',
        filter: 'attention',
        counts: [{ locale: 'ko', articles: 2, reviewed: 1, notTranslated: 1, stale: 0 }],
        total: 1,
        articles: [{ id: camera, title: 'Camera settings', languages: { ko: 'not_translated' } }],
      });
      expect(after).toMatchObject({ counts: [{ locale: 'ko', stale: 1 }], total: 2 });
      expect((after.articles as Row[])[0]).toEqual({
        id: widget,
        title: 'Add a widget',
        languages: { ko: 'reviewed, stale' },
      });
      expect([(page.articles as Row[]).map(each => each.id), page.nextOffset]).toEqual([[widget], 1]);
      expect([(next.articles as Row[]).map(each => each.id), next.nextOffset]).toEqual([[camera], undefined]);
      expect(stale.articles).toEqual([
        {
          id: widget,
          title: 'Add a widget',
          collection: 'Getting started',
          section: 'Basics',
          languages: [{ locale: 'ko', state: 'reviewed', isStale: true, hasProposal: false, lastError: null }],
        },
      ]);
    });

    it('reads one language for review, with the source segments that changed', async () => {
      await editSource();
      const concise = bodyOf(await call('mocco_help_translation_get', { articleId: widget, locale: 'ko' }));
      const detailed = bodyOf(
        await call('mocco_help_translation_get', {
          articleId: `${widget}-add-a-widget`,
          locale: 'ko',
          responseFormat: 'detailed',
        }),
      );

      expect(concise).toMatchObject({
        id: widget,
        locale: 'ko',
        state: 'reviewed',
        isStale: true,
        textKind: 'human_edit',
        reviewedBy: 'Ada',
        hasProposal: false,
        changes: [
          {
            change: 'changed',
            kind: 'paragraph',
            before: expect.stringMatching(/^Long-press the home screen\./u),
            after: expect.stringMatching(/^Touch and hold the home screen\./u),
          },
        ],
      });
      expect(concise.source).toBeUndefined();
      expect(detailed).toMatchObject({
        text: { title: '위젯 추가하기', body: '홈 화면을 길게 누르세요.' },
        proposal: null,
      });
      expect(String((detailed.source as Row).body)).toMatch(/^Touch and hold/u);
    });

    it('never reads another workspace’s help center, nor a language the site doesn’t offer', async () => {
      const foreignList = await call('mocco_help_translations_list', { ...theirs, filter: 'all' });
      const foreignGet = await call('mocco_help_translation_get', { ...theirs, articleId: theirArticle, locale: 'ko' });
      const crossed = await call('mocco_help_translation_get', { articleId: theirArticle, locale: 'ko' });
      const unoffered = await call('mocco_help_translation_get', { articleId: widget, locale: 'ja' });

      expect([foreignList, foreignGet, crossed, unoffered].map(answer => answer.result?.isError)).toEqual([
        true,
        true,
        true,
        true,
      ]);
      expect([textOf(foreignList), textOf(foreignGet), textOf(crossed)].join(' ')).not.toContain('secret');
    });
  });

  describe('mocco_help_glossary_list', () => {
    it('lists the glossary concise or detailed, filtered by rule, language and text, paged', async () => {
      const all = bodyOf(await call('mocco_help_glossary_list', {}));
      const fixed = bodyOf(await call('mocco_help_glossary_list', { rule: 'fixed', limit: 1 }));
      const found = bodyOf(await call('mocco_help_glossary_list', { query: 'steuer', responseFormat: 'detailed' }));

      expect(all).toEqual({
        total: 3,
        terms: [
          { term: 'ShowYourTime', rule: 'keep' },
          { term: 'widget', rule: 'fixed', translations: { de: 'Steuerelement' } },
          { term: 'workspace', rule: 'fixed', translations: { de: 'Arbeitsbereich' } },
        ],
      });
      expect(fixed).toEqual({
        total: 2,
        terms: [{ term: 'widget', rule: 'fixed', translations: { de: 'Steuerelement' } }],
        nextOffset: 1,
      });
      expect(found).toMatchObject({ total: 1, terms: [{ term: 'widget', id: expect.any(String), note: '' }] });
    });

    it('never reads another workspace’s glossary', async () => {
      const foreign = await call('mocco_help_glossary_list', { ...theirs });

      expect(foreign.result?.isError).toBe(true);
      expect(textOf(foreign)).not.toContain('SecretName');
    });
  });

  describe('mocco_help_articles_get', () => {
    it('reads an article concise (an excerpt) or detailed (the whole Markdown), saying the language', async () => {
      const concise = bodyOf(await call('mocco_help_articles_get', { articleId: widget }));
      const detailed = bodyOf(
        await call('mocco_help_articles_get', { articleId: `${widget}-stale`, responseFormat: 'detailed' }),
      );
      const korean = bodyOf(await call('mocco_help_articles_get', { articleId: widget, locale: 'ko' }));
      // Not translated into Korean: the source text, and `locale` says so.
      const untranslated = bodyOf(await call('mocco_help_articles_get', { articleId: camera, locale: 'ko' }));

      expect(concise).toMatchObject({ id: widget, title: 'Add a widget', locale: 'en', locales: ['en', 'ko'] });
      expect(concise.isTruncated).toBe(true);
      expect(String(concise.body).length).toBeLessThan(String(detailed.body).length);
      expect(detailed.isTruncated).toBeUndefined();
      expect(korean).toMatchObject({ locale: 'ko', title: '위젯 추가하기', body: '홈 화면을 길게 누르세요.' });
      expect(untranslated).toMatchObject({ locale: 'en', title: 'Camera settings' });
    });

    it('adds readers’ answers from the last 30 days, and comments only when detailed, never who answered', async () => {
      const vote = async (isHelpful: boolean, visitorId: string, comment?: string) =>
        await help.helpFeedback.recordInProject(
          mine.workspaceId,
          mine.projectId,
          widget,
          { helpful: isHelpful, ...(comment !== undefined && { comment }) },
          { visitorId },
        );
      await vote(true, 'visitor-aaaa');
      await vote(true, 'visitor-bbbb');
      await vote(false, 'visitor-cccc', 'Missing Android steps');

      const concise = bodyOf(await call('mocco_help_articles_get', { articleId: widget }));
      const detailed = bodyOf(await call('mocco_help_articles_get', { articleId: widget, responseFormat: 'detailed' }));
      const unanswered = bodyOf(await call('mocco_help_articles_get', { articleId: camera }));
      const stored = await t.db.select().from(helpFeedback);
      const hashes = stored.map(row => row.visitorHash);

      expect(concise.helpfulness).toEqual({ days: 30, helpful: 2, notHelpful: 1, share: 0.67 });
      expect(detailed.helpfulness).toMatchObject({
        helpful: 2,
        notHelpful: 1,
        comments: [{ helpful: false, comment: 'Missing Android steps', locale: 'en' }],
      });
      expect(unanswered.helpfulness).toEqual({ days: 30, helpful: 0, notHelpful: 0, share: null });
      const text = JSON.stringify([concise, detailed]);
      expect(hashes.some(hash => text.includes(hash)) || /visitor/u.test(text)).toBe(false);
    });

    it('reads a draft, an unpublished article and another workspace’s like ones that do not exist', async () => {
      const answers = await Promise.all(
        [draft, pulled, 'zzzzzz'].map(async articleId => await call('mocco_help_articles_get', { articleId })),
      );
      const foreign = await call('mocco_help_articles_get', { ...theirs, articleId: theirArticle });
      const sameProjectGuess = await call('mocco_help_articles_get', { articleId: theirArticle });

      expect(answers.map(answer => answer.result?.isError)).toEqual([true, true, true]);
      const ids = [draft, pulled, 'zzzzzz'];
      // A draft and an unpublished article read exactly like an id that was never used.
      expect(new Set(answers.map((answer, index) => textOf(answer).replaceAll(ids[index] ?? '', '<id>'))).size).toBe(1);
      expect([foreign.result?.isError, sameProjectGuess.result?.isError]).toEqual([true, true]);
      expect(textOf(foreign) + textOf(sameProjectGuess)).not.toContain('secret');
    });
  });

  it('refuses where the help center product is off, as the console does', async () => {
    await project.products.disable(mine.workspaceId, Products.helpcenter);

    const answers = await Promise.all([
      call('mocco_help_articles_search', { query: 'widget' }),
      call('mocco_help_articles_get', { articleId: widget }),
    ]);

    expect(answers.map(answer => answer.result?.isError)).toEqual([true, true]);
    expect(answers.every(answer => textOf(answer).includes('not enabled'))).toBe(true);
  });
});
