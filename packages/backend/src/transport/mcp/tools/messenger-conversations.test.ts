// `mocco_messenger_conversation_set_status`, `mocco_messenger_note_create` and
// `mocco_messenger_contact_set_blocked` over a real database, through the real HTTP handler.
//
// Each has every lock a changing tool has: `messenger:write` (a token without it is
// challenged for it), the workspace's opt-in, and a confirmation that shows the exact change
// and is bound to the state it showed, so an answer given after someone else changed it is
// refused. Until the person says yes, nothing is written; another workspace's conversation or
// contact reads exactly like one that does not exist.
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
import { userHashOf } from '@backend/domain/messenger/identity';
import { createProjectDomain } from '@backend/domain/project/instance';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  members,
  messengerContacts,
  messengerConversations,
  messengerMessages,
  users,
  workspaces,
} from '@backend/infra/db/schema';
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

const SET_STATUS = 'mocco_messenger_conversation_set_status';
const NOTE = 'mocco_messenger_note_create';
const BLOCK = 'mocco_messenger_contact_set_blocked';

type Row = Record<string, unknown>;

function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

interface Scope {
  workspaceId: string;
  projectId: string;
}

describe('mocco_messenger_* conversation changes (pglite, over HTTP)', () => {
  let t: TestDb;
  let messenger: MessengerDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let ada: string;
  let bo: string;
  let mine: Scope;
  /** Minji's open conversation. */
  let billing: string;
  /** Minji's closed one. */
  let closed: string;
  /** A conversation in another workspace, and its contact. */
  let foreign: string;
  let foreignContact: string;
  let minji: string;

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

  const statusOf = async (conversationId: string) =>
    expectOne(await t.db.select().from(messengerConversations).where(eq(messengerConversations.id, conversationId)))
      .status;
  const messagesIn = async (conversationId: string) =>
    await t.db.select().from(messengerMessages).where(eq(messengerMessages.conversationId, conversationId));
  const blockedAtOf = async (contactId: string) =>
    expectOne(await t.db.select().from(messengerContacts).where(eq(messengerContacts.id, contactId))).blockedAt;
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

  async function contactIn(scope: Scope, userId: string, name: string) {
    const { identitySecret } = await messenger.messengerSettings.enable(scope.workspaceId, scope.projectId, ada);
    const session = await messenger.contactMessenger.createSession(scope, {
      userId,
      userHash: userHashOf(identitySecret, userId),
      name,
    });
    const principal = await messenger.contactMessenger.authenticate(session.sessionToken);
    if (principal === undefined) {
      throw new Error('fixture contact did not authenticate');
    }
    return principal;
  }

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    messenger = createMessengerDomain(t.db, { audit, box: () => box });
    project = createProjectDomain(t.db);
    ada = await person('Ada', 'ada@acme.test');
    bo = await person('Bo', 'bo@acme.test');
    const eve = await person('Eve', 'eve@acme.test');
    mine = await addWorkspace(ada, bo);
    const theirs = await addWorkspace(eve);

    const principal = await contactIn(mine, 'minji-1', 'Minji');
    minji = principal.contact.id;
    ({ id: billing } = await messenger.contactMessenger.startConversation(principal, {
      body: 'I was charged twice',
      clientMessageId: randomUUID(),
    }));
    ({ id: closed } = await messenger.contactMessenger.startConversation(principal, {
      body: 'How do I export?',
      clientMessageId: randomUUID(),
    }));
    await messenger.inbox.setStatus(mine.workspaceId, mine.projectId, bo, { conversationId: closed, status: 'closed' });

    const stranger = await contactIn(theirs, 'minji-1', 'Their customer');
    foreignContact = stranger.contact.id;
    ({ id: foreign } = await messenger.contactMessenger.startConversation(stranger, {
      body: 'Their secret question',
      clientMessageId: randomUUID(),
    }));

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

  describe(SET_STATUS, () => {
    it('asks first, naming the contact and the change, and closes nothing until answered', async () => {
      const { asked } = await ask(SET_STATUS, { conversationId: billing, status: 'closed' });

      expect(messageOf(asked)).toContain('Close this conversation with Minji, as you?');
      expect(messageOf(asked)).toContain('open → closed');
      expect(await statusOf(billing)).toBe('open');
    });

    it('closes once confirmed, recorded as the person, and reopens the same way', async () => {
      const closedNow = bodyOf(await confirmed(SET_STATUS, { conversationId: billing, status: 'closed' }));
      const reopened = bodyOf(await confirmed(SET_STATUS, { conversationId: billing, status: 'open' }));

      expect(closedNow).toMatchObject({ changed: true, conversationId: billing, status: 'closed' });
      expect(closedNow.closedAt).toEqual(expect.any(String));
      expect(reopened).toMatchObject({ changed: true, status: 'open', closedAt: null });
      expect(await statusOf(billing)).toBe('open');
      // The fixture's own close (Bo's) is first.
      const closes = await audited(AuditActions.messengerConversationClosed);
      const close = closes.find(entry => entry.subjectId === billing);
      const [reopen] = await audited(AuditActions.messengerConversationReopened);
      expect(close).toMatchObject({ actorUserId: ada, subjectId: billing, payload: { projectId: mine.projectId } });
      expect(reopen).toMatchObject({ actorUserId: ada, subjectId: billing });
    });

    it('closes nothing when the person says no, and answers without asking when it is so already', async () => {
      const declined = bodyOf(await confirmed(SET_STATUS, { conversationId: billing, status: 'closed' }, false));
      const already = await call(SET_STATUS, { conversationId: closed, status: 'closed' }, WITH_MESSENGER_WRITE);

      expect(declined).toMatchObject({ changed: false });
      expect(await statusOf(billing)).toBe('open');
      expect(already.result?.resultType).not.toBe('input_required');
      expect(bodyOf(already)).toMatchObject({ changed: false, status: 'closed' });
    });

    it('refuses a stale answer after someone else closed and reopened it, and another conversation', async () => {
      const { requestState } = await ask(SET_STATUS, { conversationId: billing, status: 'closed' });
      const round = { requestState, inputResponses: accepting(true) };

      const replayed = await call(SET_STATUS, { conversationId: closed, status: 'open' }, WITH_MESSENGER_WRITE, round);
      // Bo closes it from the console; the agent's answer is now about a change already made.
      await messenger.inbox.setStatus(mine.workspaceId, mine.projectId, bo, {
        conversationId: billing,
        status: 'closed',
      });
      const meanwhile = await call(
        SET_STATUS,
        { conversationId: billing, status: 'closed' },
        WITH_MESSENGER_WRITE,
        round,
      );
      await messenger.inbox.setStatus(mine.workspaceId, mine.projectId, bo, {
        conversationId: billing,
        status: 'open',
      });

      expect(textOf(replayed)).toContain('different change');
      expect(await statusOf(closed)).toBe('closed');
      // Closed in between: nothing to do, and nothing written as Ada.
      expect(bodyOf(meanwhile)).toMatchObject({ changed: false });
      const closes = await audited(AuditActions.messengerConversationClosed);
      expect(closes.map(entry => entry.actorUserId)).toEqual([bo, bo]);
    });

    it("refuses another workspace's conversation exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const theirs = await call(SET_STATUS, { conversationId: foreign, status: 'closed' }, WITH_MESSENGER_WRITE);
      const missing = await call(SET_STATUS, { conversationId: nowhere, status: 'closed' }, WITH_MESSENGER_WRITE);

      expect(theirs.result?.isError).toBe(true);
      expect(textOf(theirs).replace(foreign, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(await statusOf(foreign)).toBe('open');
    });

    it('refuses where the workspace has not allowed agents, and challenges a token without the scope', async () => {
      const unscoped = await call(SET_STATUS, { conversationId: billing, status: 'closed' }, [
        ...SIGN_IN,
        'feedback:write',
      ]);
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);
      const optedOut = await call(SET_STATUS, { conversationId: billing, status: 'closed' }, WITH_MESSENGER_WRITE);

      expect(unscoped.status).toBe(403);
      expect(unscoped.wwwAuthenticate).toContain(
        'scope="messenger:write openid profile email offline_access feedback:write"',
      );
      expect(optedOut.result?.resultType).not.toBe('input_required');
      expect(textOf(optedOut)).toContain('Agents may not close or reopen conversations in this workspace');
      expect(await statusOf(billing)).toBe('open');
    });
  });

  describe(NOTE, () => {
    it('asks first with the exact text, saying the contact never sees it, and writes nothing until answered', async () => {
      const { asked } = await ask(NOTE, { conversationId: billing, body: 'Refund issued in Stripe' });

      expect(messageOf(asked)).toContain('Leave this note in the conversation with Minji, as you?');
      expect(messageOf(asked)).toContain('the contact never does');
      expect(messageOf(asked)).toContain('Refund issued in Stripe');
      expect(await messagesIn(billing)).toHaveLength(1);
    });

    it('writes an internal note as the person once confirmed, never a public message', async () => {
      const body = bodyOf(await confirmed(NOTE, { conversationId: billing, body: 'Refund issued in Stripe' }));

      expect(body).toMatchObject({ changed: true, conversationId: billing, seq: 2 });
      const thread = await messagesIn(billing);
      const written = thread.find(message => message.seq === 2);
      expect(written).toMatchObject({
        authorKind: 'operator',
        authorUserId: ada,
        visibility: 'internal',
        body: 'Refund issued in Stripe',
      });
    });

    it('writes once when the same confirmation is answered twice, and refuses it for other text', async () => {
      const args = { conversationId: billing, body: 'Checked: duplicate charge' };
      const { requestState } = await ask(NOTE, args);
      const round = { requestState, inputResponses: accepting(true) };

      const other = await call(NOTE, { ...args, body: 'Something else' }, WITH_MESSENGER_WRITE, round);
      const first = await call(NOTE, args, WITH_MESSENGER_WRITE, round);
      const again = await call(NOTE, args, WITH_MESSENGER_WRITE, round);

      expect(textOf(other)).toContain('different change');
      expect(bodyOf(first)).toMatchObject({ changed: true });
      expect(again.result?.isError).toBe(true);
      const bodies = await messagesIn(billing);
      expect(bodies.map(message => message.body)).toEqual(['I was charged twice', 'Checked: duplicate charge']);
    });

    it('writes nothing when the person says no, nor in another workspace', async () => {
      const declined = bodyOf(await confirmed(NOTE, { conversationId: billing, body: 'Hm' }, false));
      const theirs = await call(NOTE, { conversationId: foreign, body: 'Hm' }, WITH_MESSENGER_WRITE);

      expect(declined).toMatchObject({ changed: false });
      expect(theirs.result?.resultType).not.toBe('input_required');
      expect(theirs.result?.isError).toBe(true);
      expect(await messagesIn(billing)).toHaveLength(1);
      expect(await messagesIn(foreign)).toHaveLength(1);
    });
  });

  describe(BLOCK, () => {
    it('asks first, saying what blocking does, and blocks nothing until answered', async () => {
      const { asked } = await ask(BLOCK, { contactId: minji, blocked: true });

      expect(messageOf(asked)).toContain('Block Minji, as you?');
      expect(messageOf(asked)).toContain('can no longer write');
      expect(await blockedAtOf(minji)).toBeNull();
    });

    it('blocks once confirmed, recorded as the person, and the contact can no longer write', async () => {
      const body = bodyOf(await confirmed(BLOCK, { contactId: minji, blocked: true }));

      expect(body).toEqual({ changed: true, contactId: minji, isBlocked: true });
      expect(await blockedAtOf(minji)).not.toBeNull();
      const [entry] = await audited(AuditActions.messengerContactBlocked);
      expect(entry).toMatchObject({ actorUserId: ada, subjectId: minji, payload: { blocked: true } });
      const read = bodyOf(await call('mocco_messenger_conversation_get', { conversationId: billing }));
      expect(read.contact).toMatchObject({ isBlocked: true });
    });

    it('unblocks the same way, and answers without asking when nothing would change', async () => {
      const already = await call(BLOCK, { contactId: minji, blocked: false }, WITH_MESSENGER_WRITE);
      bodyOf(await confirmed(BLOCK, { contactId: minji, blocked: true }));
      const unblocked = bodyOf(await confirmed(BLOCK, { contactId: minji, blocked: false }));

      expect(already.result?.resultType).not.toBe('input_required');
      expect(bodyOf(already)).toMatchObject({ changed: false, isBlocked: false });
      expect(unblocked).toMatchObject({ changed: true, isBlocked: false });
      expect(await blockedAtOf(minji)).toBeNull();
    });

    it('refuses a stale answer after someone else blocked them, and blocks nothing when told no', async () => {
      const declined = bodyOf(await confirmed(BLOCK, { contactId: minji, blocked: true }, false));
      const { requestState } = await ask(BLOCK, { contactId: minji, blocked: true });
      await messenger.inbox.setContactBlocked(mine.workspaceId, mine.projectId, bo, {
        contactId: minji,
        blocked: true,
      });
      await messenger.inbox.setContactBlocked(mine.workspaceId, mine.projectId, bo, {
        contactId: minji,
        blocked: false,
      });
      // Blocked and unblocked in between: same state, so the answer still matches and applies.
      const answered = await call(BLOCK, { contactId: minji, blocked: true }, WITH_MESSENGER_WRITE, {
        requestState,
        inputResponses: accepting(true),
      });
      const stale = await call(BLOCK, { contactId: minji, blocked: false }, WITH_MESSENGER_WRITE, {
        requestState,
        inputResponses: accepting(true),
      });

      expect(declined).toMatchObject({ changed: false });
      expect(bodyOf(answered)).toMatchObject({ changed: true, isBlocked: true });
      expect(textOf(stale)).toContain('different change');
      expect(await blockedAtOf(minji)).not.toBeNull();
    });

    it("refuses another workspace's contact exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const theirs = await call(BLOCK, { contactId: foreignContact, blocked: true }, WITH_MESSENGER_WRITE);
      const missing = await call(BLOCK, { contactId: nowhere, blocked: true }, WITH_MESSENGER_WRITE);

      expect(theirs.result?.resultType).not.toBe('input_required');
      expect(textOf(theirs).replace(foreignContact, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(await blockedAtOf(foreignContact)).toBeNull();
    });
  });
});
