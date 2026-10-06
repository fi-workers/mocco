// `mocco_help_translation_accept`, `_translation_retranslate` and `mocco_help_glossary_set` over a
// real database, through the real HTTP handler.
//
// The three changes have every lock a changing tool has (`help:write`, the workspace's opt-in, a
// confirmation naming exactly what would change), write nothing until the person says yes, refuse
// an answer once the state it was asked about has moved (a newer draft, a language reviewed since,
// a term changed since), and apply a confirmation answered twice once.
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
  throw new Error('the help change tools must not reach another domain');
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
const ACCEPT = 'mocco_help_translation_accept';
const RETRANSLATE = 'mocco_help_translation_retranslate';
const GLOSSARY_SET = 'mocco_help_glossary_set';

const BODY = '## Add the widget\n\nTap [here](https://a.test).';
const EDITED = '## Add the widget\n\nPress [here](https://a.test).\n\nNew line.';
const EDITED_AGAIN = '## Add the widget\n\nPress and hold [here](https://a.test).\n\nNew line.';

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

interface Scope {
  workspaceId: string;
  projectId: string;
}

interface Queued {
  workspaceId: string;
  articleId?: string;
  locale?: string;
  fresh?: boolean;
}

describe('mocco_help translation and glossary changes (pglite, over HTTP)', () => {
  let t: TestDb;
  let help: HelpDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let queued: Queued[];
  let ada: string;
  let mine: Scope;
  let theirs: Scope;
  /** Reviewed in Korean by Ada, then edited and republished: a machine draft waits beside it. */
  let widget: { id: string; shortId: string };
  /** Machine translated into Korean, never reviewed. */
  let camera: { id: string; shortId: string };
  /** Another workspace's article. */
  let theirArticle: string;

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

  /** Run every queued article translation, as the job runner would. */
  async function drain() {
    const jobs = [...queued];
    queued.length = 0;
    await jobs.reduce(async (previous, job) => {
      await previous;
      if (job.articleId !== undefined && job.locale !== undefined) {
        await help.helpTranslations.translateArticle({ ...job, articleId: job.articleId, locale: job.locale });
      }
    }, Promise.resolve());
  }

  const auditedAs = async (action: string) => {
    const rows = await t.db.select().from(auditLog);
    return rows.filter(row => row.action === action).map(row => row.actorUserId);
  };

  const reviewOf = async (articleId: string) =>
    await help.helpTranslations.review(mine.workspaceId, mine.projectId, articleId, 'ko');

  const glossaryOf = async (scope: Scope) => {
    const { terms } = await help.helpGlossary.list(scope.workspaceId, scope.projectId);
    return terms;
  };

  const acceptArgs = () => ({ articleId: widget.shortId, locale: 'ko' });

  /** Each change with arguments it would ask about. */
  const changes = (): [string, Record<string, unknown>][] => [
    [ACCEPT, acceptArgs()],
    [RETRANSLATE, { articleId: camera.shortId, locale: 'ko' }],
    [GLOSSARY_SET, { term: 'widget', rule: 'keep' }],
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

  /** A help site in `scope` with one section; `write` publishes an article into it. */
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
    return async (title: string, body: string) => {
      const article = await help.helpAuthoring.createArticle(workspaceId, projectId, authorId, {
        sectionId: section.id,
        title,
      });
      await help.helpAuthoring.saveDraft(workspaceId, projectId, authorId, { articleId: article.id, title, body });
      await help.helpAuthoring.publish(workspaceId, projectId, authorId, article.id);
      return { id: article.id, shortId: article.shortId };
    };
  }

  const republish = async (articleId: string, body: string) => {
    await help.helpAuthoring.saveDraft(mine.workspaceId, mine.projectId, ada, { articleId, title: 'Widget', body });
    await help.helpAuthoring.publish(mine.workspaceId, mine.projectId, ada, articleId);
    await drain();
  };

  beforeEach(async () => {
    t = await createTestDb();
    queued = [];
    help = createHelpDomain(t.db, {
      audit: new AuditService({ audit: new AuditRepo(t.db) }),
      translator: new FakeTranslator(),
      queue: {
        enqueue: async (_job, payload) => {
          queued.push(payload as Queued);
          return await Promise.resolve({ job: { id: randomUUID() } as never, created: true });
        },
        kick: () => {},
      },
    });
    project = createProjectDomain(t.db);
    ada = await person('Ada');
    const eve = await person('Eve');
    mine = await addWorkspace(ada);
    theirs = await addWorkspace(eve);

    const write = await site(mine, ada);
    widget = await write('Widget', BODY);
    camera = await write('Camera', 'Open the camera.');
    await drain();
    await help.helpTranslations.saveTranslation(mine.workspaceId, mine.projectId, ada, {
      articleId: widget.id,
      locale: 'ko',
      title: '위젯',
      body: '## 위젯 추가\n\n[여기](https://a.test)를 누르세요.',
    });
    await republish(widget.id, EDITED);
    await help.helpGlossary.addTerm(mine.workspaceId, mine.projectId, ada, { term: 'ShowYourTime', rule: 'keep' });

    const writeTheirs = await site(theirs, eve);
    ({ shortId: theirArticle } = await writeTheirs('Their secret widget', 'Shh.'));
    await help.helpGlossary.addTerm(theirs.workspaceId, theirs.projectId, eve, { term: 'SecretName', rule: 'keep' });
    queued.length = 0;

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

  describe(ACCEPT, () => {
    const args = acceptArgs;

    it('asks first, naming the article and showing the draft, and changes nothing until answered', async () => {
      const { asked } = await ask(ACCEPT, args());

      expect(messageOf(asked)).toContain(`article ${widget.shortId} in ko`);
      expect(messageOf(asked)).toContain('the text Ada reviewed');
      expect(messageOf(asked)).toContain('KO New line.');
      expect(await reviewOf(widget.id)).toMatchObject({ isStale: true, proposal: expect.any(Object) });
    });

    it('accepts the draft as the person once confirmed, and not when they say no', async () => {
      const { requestState } = await ask(ACCEPT, args());
      const declined = await answer(ACCEPT, args(), requestState, false);
      expect(bodyOf(declined)).toMatchObject({ changed: false });
      expect(await auditedAs(AuditActions.helpTranslationProposalAccepted)).toEqual([]);

      const { proposal: draft } = await reviewOf(widget.id);
      const accepted = bodyOf(await confirmed(ACCEPT, args()));

      expect(accepted).toMatchObject({ accepted: true, id: widget.shortId, state: 'reviewed', reviewedBy: 'Ada' });
      expect(await reviewOf(widget.id)).toMatchObject({
        isStale: false,
        proposal: null,
        textKind: 'human_edit',
        text: { body: draft?.body },
      });
      expect(await auditedAs(AuditActions.helpTranslationProposalAccepted)).toEqual([ada]);
    });

    it('refuses a confirmation once a newer draft replaced the one shown', async () => {
      const { requestState } = await ask(ACCEPT, args());
      await republish(widget.id, EDITED_AGAIN);

      const stale = await answer(ACCEPT, args(), requestState);

      expect(stale.result?.isError).toBe(true);
      expect(textOf(stale)).toContain('different change');
      expect(await auditedAs(AuditActions.helpTranslationProposalAccepted)).toEqual([]);
      expect(await reviewOf(widget.id)).toMatchObject({ isStale: true, proposal: expect.any(Object) });
    });

    it('applies a confirmation answered twice once, and refuses the second', async () => {
      const { requestState } = await ask(ACCEPT, args());
      const round = { requestState, inputResponses: accepting(true) };

      const first = await call(ACCEPT, args(), WRITE, round);
      const again = await call(ACCEPT, args(), WRITE, round);

      expect(bodyOf(first)).toMatchObject({ accepted: true });
      expect(again.result?.isError).toBe(true);
      expect(textOf(again)).toContain('No machine draft waits');
      expect(await auditedAs(AuditActions.helpTranslationProposalAccepted)).toEqual([ada]);
    });

    it('refuses a language without a draft before asking', async () => {
      const answered = await call(ACCEPT, { articleId: camera.shortId, locale: 'ko' }, WRITE);

      expect(answered.result?.isError).toBe(true);
      expect(answered.result?.resultType).not.toBe('input_required');
      expect(textOf(answered)).toContain('No machine draft waits');
    });
  });

  describe(RETRANSLATE, () => {
    it('asks first, then translates a machine language again as the person, fresh', async () => {
      const args = { articleId: camera.shortId, locale: 'ko' };
      const { asked, requestState } = await ask(RETRANSLATE, args);
      expect(messageOf(asked)).toContain(`Translate article ${camera.shortId} into ko again`);
      const declined = await answer(RETRANSLATE, args, requestState, false);
      expect(bodyOf(declined)).toMatchObject({ changed: false });
      expect(queued).toEqual([]);

      const done = bodyOf(await confirmed(RETRANSLATE, args));

      expect(done).toMatchObject({ queued: true, id: camera.shortId, replacesReviewed: false });
      expect(queued).toEqual([expect.objectContaining({ articleId: camera.id, locale: 'ko', fresh: true })]);
      expect(await auditedAs(AuditActions.helpTranslationRetranslated)).toEqual([ada]);
    });

    it('replaces a reviewed language only with the explicit confirmation, which names the reviewer', async () => {
      const args = { articleId: widget.shortId, locale: 'ko' };
      const { asked } = await ask(RETRANSLATE, args);
      expect(messageOf(asked)).toContain('Replace the reviewed ko translation');
      expect(messageOf(asked)).toContain('reviewed by Ada');

      const done = bodyOf(await confirmed(RETRANSLATE, args));

      expect(done).toMatchObject({ queued: true, replacesReviewed: true });
      const rows = await t.db.select().from(auditLog);
      const entry = rows.find(row => row.action === AuditActions.helpTranslationRetranslated);
      expect(entry).toMatchObject({ actorUserId: ada, payload: expect.objectContaining({ replacesReviewed: true }) });
    });

    it('refuses a confirmation once the language was reviewed since, and replaces nothing', async () => {
      const args = { articleId: camera.shortId, locale: 'ko' };
      const { requestState } = await ask(RETRANSLATE, args);
      await help.helpTranslations.saveTranslation(mine.workspaceId, mine.projectId, ada, {
        articleId: camera.id,
        locale: 'ko',
        title: '카메라',
        body: '카메라를 여세요.',
      });

      const stale = await answer(RETRANSLATE, args, requestState);

      expect(textOf(stale)).toContain('different change');
      expect(queued).toEqual([]);
      expect(await reviewOf(camera.id)).toMatchObject({ state: 'reviewed', text: { title: '카메라' } });
      expect(await auditedAs(AuditActions.helpTranslationRetranslated)).toEqual([]);
    });

    it('applies a confirmation answered twice once: the second finds it under way', async () => {
      const args = { articleId: camera.shortId, locale: 'ko' };
      const { requestState } = await ask(RETRANSLATE, args);
      const round = { requestState, inputResponses: accepting(true) };

      const first = await call(RETRANSLATE, args, WRITE, round);
      const again = await call(RETRANSLATE, args, WRITE, round);

      expect(bodyOf(first)).toMatchObject({ queued: true });
      expect(bodyOf(again)).toMatchObject({ changed: false, state: 'pending' });
      expect(queued).toHaveLength(1);
      expect(await auditedAs(AuditActions.helpTranslationRetranslated)).toEqual([ada]);
    });
  });

  describe(GLOSSARY_SET, () => {
    it('asks first, then adds a term as the person', async () => {
      const args = { term: 'widget', rule: 'fixed', translations: { ko: '위젯' } };
      const { asked } = await ask(GLOSSARY_SET, args);
      expect(messageOf(asked)).toContain('Add "widget" to the help center glossary');
      expect(messageOf(asked)).toContain('As: "widget", translated as ko: 위젯');
      expect(await glossaryOf(mine)).toHaveLength(1);

      const added = bodyOf(await confirmed(GLOSSARY_SET, args));

      expect(added).toMatchObject({ changed: true, added: true, term: 'widget', translations: { ko: '위젯' } });
      const terms = await glossaryOf(mine);
      expect(terms.map(term => term.term)).toEqual(['ShowYourTime', 'widget']);
      expect(await auditedAs(AuditActions.helpGlossaryChanged)).toContain(ada);
    });

    it('changes a term it has in any case, keeps its note, and says so without asking when nothing changes', async () => {
      const [kept] = await glossaryOf(mine);
      await help.helpGlossary.updateTerm(mine.workspaceId, mine.projectId, ada, kept?.id ?? '', {
        term: 'ShowYourTime',
        rule: 'keep',
        note: 'The product name',
      });
      const args = { term: 'showyourtime', rule: 'fixed', translations: { ko: '쇼유어타임' } };
      const { asked } = await ask(GLOSSARY_SET, args);
      expect(messageOf(asked)).toContain('Now: "ShowYourTime", kept as written in every language');
      expect(messageOf(asked)).toContain('After: "showyourtime", translated as ko: 쇼유어타임');

      const changed = bodyOf(await confirmed(GLOSSARY_SET, args));
      const same = await call(GLOSSARY_SET, args, WRITE);

      expect(changed).toMatchObject({ updated: true, rule: 'fixed', note: 'The product name' });
      expect(same.result?.resultType).not.toBe('input_required');
      expect(bodyOf(same)).toMatchObject({ changed: false });
    });

    it('removes a term once confirmed, and says so without asking for one it does not have', async () => {
      const removed = bodyOf(await confirmed(GLOSSARY_SET, { term: 'ShowYourTime', remove: true }));
      const missing = await call(GLOSSARY_SET, { term: 'Nothing', remove: true }, WRITE);

      expect(removed).toMatchObject({ changed: true, removed: true });
      expect(await glossaryOf(mine)).toEqual([]);
      expect(missing.result?.resultType).not.toBe('input_required');
      expect(bodyOf(missing)).toMatchObject({ changed: false });
    });

    it('refuses a confirmation once the term was changed since, keeping that change', async () => {
      const args = { term: 'ShowYourTime', rule: 'fixed', translations: { ko: '쇼유어타임' } };
      const { requestState } = await ask(GLOSSARY_SET, args);
      const [term] = await glossaryOf(mine);
      await help.helpGlossary.updateTerm(mine.workspaceId, mine.projectId, ada, term?.id ?? '', {
        term: 'ShowYourTime',
        rule: 'keep',
        note: 'Changed in the console',
      });

      const stale = await answer(GLOSSARY_SET, args, requestState);

      expect(textOf(stale)).toContain('different change');
      expect(await glossaryOf(mine)).toMatchObject([{ rule: 'keep', note: 'Changed in the console' }]);
    });

    it('applies a confirmation answered twice once', async () => {
      const args = { term: 'widget', rule: 'keep' };
      const { requestState } = await ask(GLOSSARY_SET, args);
      const round = { requestState, inputResponses: accepting(true) };

      const first = await call(GLOSSARY_SET, args, WRITE, round);
      const again = await call(GLOSSARY_SET, args, WRITE, round);

      expect(bodyOf(first)).toMatchObject({ changed: true, added: true });
      expect(bodyOf(again)).toMatchObject({ changed: false });
      const terms = await glossaryOf(mine);
      expect(terms.filter(term => term.term === 'widget')).toHaveLength(1);
    });

    it('refuses a term the glossary rules reject before asking', async () => {
      const answers = await Promise.all([
        call(GLOSSARY_SET, { term: 'widget', rule: 'fixed' }, WRITE),
        call(GLOSSARY_SET, { term: 'widget' }, WRITE),
      ]);

      expect(answers.map(each => [each.result?.isError, each.result?.resultType === 'input_required'])).toEqual([
        [true, false],
        [true, false],
      ]);
      expect(textOf(answers[0] ?? {})).toContain('needs a translation');
    });
  });

  describe('locks', () => {
    it('challenges a token without help:write for it, keeping the scopes it has', async () => {
      await changes().reduce(async (previous, [tool, args]) => {
        await previous;
        const challenged = await call(tool, args, [...SIGN_IN, 'feedback:write']);
        expect(challenged.status, tool).toBe(403);
        expect(challenged.wwwAuthenticate).toContain('insufficient_scope');
        expect(challenged.wwwAuthenticate).toContain('help:write');
        expect(challenged.wwwAuthenticate).toContain('feedback:write');
      }, Promise.resolve());
      expect(queued).toEqual([]);
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
      expect(await glossaryOf(mine)).toHaveLength(1);
      expect(queued).toEqual([]);
    });

    it("never reaches another workspace's help center, by its workspace or by its article id", async () => {
      const foreign: [string, Record<string, unknown>][] = [
        [ACCEPT, { ...theirs, articleId: theirArticle, locale: 'ko' }],
        [RETRANSLATE, { ...theirs, articleId: theirArticle, locale: 'ko' }],
        [GLOSSARY_SET, { ...theirs, term: 'SecretName', remove: true }],
        [ACCEPT, { articleId: theirArticle, locale: 'ko' }],
        [RETRANSLATE, { articleId: theirArticle, locale: 'ko' }],
      ];
      const answers = await foreign.reduce<Promise<RpcAnswer[]>>(async (previous, [tool, args]) => {
        const done = await previous;
        return [...done, await call(tool, args, WRITE)];
      }, Promise.resolve([]));

      expect(answers.map(each => [each.result?.isError, each.result?.resultType === 'input_required'])).toEqual(
        foreign.map(() => [true, false]),
      );
      expect(answers.map(each => textOf(each)).join(' ')).not.toMatch(/secret/iu);
      const theirTerms = await glossaryOf(theirs);
      expect(theirTerms.map(term => term.term)).toEqual(['SecretName']);
      expect(queued).toEqual([]);
    });
  });

  it('marks the accept as a change, and the retranslate and glossary set as destructive', async () => {
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

    expect(hintsOf(ACCEPT)).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hintsOf(RETRANSLATE)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(hintsOf(GLOSSARY_SET)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
