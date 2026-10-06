// `mocco_messenger_*` over a real database, through the real HTTP handler.
//
// The reads must stay inside the caller's project (another workspace's conversation reads
// exactly like one that does not exist) and must never hand out an attachment's signed
// download link. Replying and assigning change what a customer reads and who owns their
// conversation, so they have every lock a changing tool has: `messenger:write` (a token
// without it is challenged for it), the workspace's opt-in, and a confirmation that shows the
// exact change; until the person says yes, nothing is written.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AuditActions } from '@mocco/common/audit';
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
import { FilesystemObjectStore } from '@backend/domain/storage/drivers/filesystem';
import { ObjectRepo } from '@backend/domain/storage/repos/object.repo';
import { StorageUrlSigner } from '@backend/domain/storage/signing';
import { StorageService } from '@backend/domain/storage/StorageService';
import { SecretBox } from '@backend/infra/crypto/secret-box';
import { expectOne } from '@backend/infra/db/rows';
import {
  auditLog,
  members,
  messengerAttachments,
  messengerConversations,
  messengerMessages,
  objects,
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
const STORAGE_URL = 'https://storage.test/api/ext/internal/storage';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  // The changes confirm through a form elicitation.
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
const WITH_MESSENGER_WRITE = [...SIGN_IN, 'messenger:write'];

type Row = Record<string, unknown>;

/** A successful answer's JSON; fails the test on a refusal, showing why. */
function bodyOf(answer: RpcAnswer): Row {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Row;
}

const idsOf = (body: Row) => (body.conversations as Row[]).map(row => row.id);

interface Scope {
  workspaceId: string;
  projectId: string;
}

describe('mocco_messenger_* (pglite, over HTTP)', () => {
  let t: TestDb;
  let root: string;
  let store: FilesystemObjectStore;
  let messenger: MessengerDomain;
  let project: ProjectDomain;
  let settings: McpSettingsService;
  let handler: McpHttpHandler;
  let ada: string;
  let bo: string;
  let eve: string;
  let mine: Scope;
  let theirs: Scope;
  /** Minji's conversation, assigned to Ada, with a reply, a note and a PDF. */
  let billing: string;
  /** Jun's, unassigned. */
  let crash: string;
  /** Minji's second, closed. */
  let closed: string;
  /** A conversation in another workspace. */
  let foreign: string;
  let minjiContact: string;

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
    bodyOf(await call('mocco_messenger_conversations_search', args));

  /** The first round of a change, which must ask; returns the answer and the state to echo. */
  async function ask(tool: string, args: Record<string, unknown>) {
    const asked = await call(tool, args, WITH_MESSENGER_WRITE);
    expect(asked.result?.resultType, textOf(asked)).toBe('input_required');
    return { asked, requestState: asked.result?.requestState ?? '' };
  }

  /** Ask, then answer: the whole round trip. */
  async function confirmed(tool: string, args: Record<string, unknown>, isConfirmed = true) {
    const { requestState } = await ask(tool, args);
    return await call(tool, args, WITH_MESSENGER_WRITE, { requestState, inputResponses: accepting(isConfirmed) });
  }

  const messagesIn = async (conversationId: string) =>
    await t.db.select().from(messengerMessages).where(eq(messengerMessages.conversationId, conversationId));

  const assigneeOf = async (conversationId: string) =>
    expectOne(await t.db.select().from(messengerConversations).where(eq(messengerConversations.id, conversationId)))
      .assigneeUserId;

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

  /** A contact signed in through the app, and the conversation they start. */
  async function contactWrites(scope: Scope, secret: string, who: { userId: string; name: string; email: string }) {
    const session = await messenger.contactMessenger.createSession(scope, {
      userId: who.userId,
      userHash: userHashOf(secret, who.userId),
      name: who.name,
      email: who.email,
    });
    const principal = await messenger.contactMessenger.authenticate(session.sessionToken);
    if (principal === undefined) {
      throw new Error('fixture contact did not authenticate');
    }
    return principal;
  }

  beforeEach(async () => {
    t = await createTestDb();
    root = await mkdtemp(path.join(tmpdir(), 'mocco-mcp-messenger-'));
    store = new FilesystemObjectStore({ root, baseUrl: STORAGE_URL, signer: new StorageUrlSigner('mcp-signing-key') });
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const box = new SecretBox([{ id: 'k1', key: Buffer.alloc(32, 7) }]);
    // A clock that moves, so each message is newer than the one before.
    let tick = Date.parse('2026-10-06T09:00:00Z');
    const now = () => {
      tick += 1000;
      return new Date(tick);
    };
    messenger = createMessengerDomain(t.db, {
      audit,
      box: () => box,
      storage: new StorageService({ objects: new ObjectRepo(t.db), store }),
      now,
    });
    project = createProjectDomain(t.db);
    ada = await person('Ada', 'ada@acme.test');
    bo = await person('Bo', 'bo@acme.test');
    eve = await person('Eve', 'eve@acme.test');
    mine = await addWorkspace(ada, bo);
    theirs = await addWorkspace(eve);

    const { identitySecret } = await messenger.messengerSettings.enable(mine.workspaceId, mine.projectId, ada);
    await messenger.inbox.addMember(mine.workspaceId, mine.projectId, ada, ada);
    const minji = await contactWrites(mine, identitySecret, {
      userId: 'minji-1',
      name: 'Minji',
      email: 'Minji@Shop.test',
    });
    minjiContact = minji.contact.id;
    // Round robin gives the first to Ada, then she steps away so the next stays unassigned.
    ({ id: billing } = await messenger.contactMessenger.startConversation(minji, {
      category: 'billing',
      body: 'I was charged twice',
      clientMessageId: randomUUID(),
    }));
    await messenger.inbox.setAvailable(mine.workspaceId, mine.projectId, { userId: ada, available: false });
    const jun = await contactWrites(mine, identitySecret, { userId: 'jun-7', name: 'Jun', email: 'jun@shop.test' });
    ({ id: crash } = await messenger.contactMessenger.startConversation(jun, {
      body: 'The app crashes on launch',
      clientMessageId: randomUUID(),
    }));
    ({ id: closed } = await messenger.contactMessenger.startConversation(minji, {
      body: 'How do I export?',
      clientMessageId: randomUUID(),
    }));
    await messenger.inbox.setStatus(mine.workspaceId, mine.projectId, closed, 'closed');

    // Ada answers Minji with a PDF attached, and leaves a note.
    const pdf = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
    const reserved = await messenger.inbox.createAttachment(mine.workspaceId, mine.projectId, ada, {
      conversationId: billing,
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
      filename: 'Receipt.pdf',
    });
    const [object] = await t.db
      .select({ key: objects.key })
      .from(messengerAttachments)
      .innerJoin(objects, eq(objects.id, messengerAttachments.objectId))
      .where(eq(messengerAttachments.id, reserved.attachmentId));
    await store.put(object?.key ?? '', pdf, { contentType: 'application/pdf', visibility: 'private' });
    await messenger.inbox.write(mine.workspaceId, mine.projectId, ada, {
      conversationId: billing,
      body: 'Refunded, receipt attached',
      internal: false,
      attachmentIds: [reserved.attachmentId],
    });
    await messenger.inbox.write(mine.workspaceId, mine.projectId, ada, {
      conversationId: billing,
      body: 'Checked Stripe: duplicate charge',
      internal: true,
    });

    const { identitySecret: theirSecret } = await messenger.messengerSettings.enable(
      theirs.workspaceId,
      theirs.projectId,
      eve,
    );
    const stranger = await contactWrites(theirs, theirSecret, {
      userId: 'minji-1',
      name: 'Their customer',
      email: 'minji@shop.test',
    });
    ({ id: foreign } = await messenger.contactMessenger.startConversation(stranger, {
      body: 'Their secret question',
      clientMessageId: randomUUID(),
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
      messengerInbox: messenger.inbox,
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
    await rm(root, { recursive: true, force: true });
  });

  describe('mocco_messenger_conversations_search', () => {
    it('lists the open conversations newest first, concise unless asked', async () => {
      const concise = await search();
      const detailed = await search({ responseFormat: 'detailed' });

      expect(idsOf(concise)).toEqual([billing, crash]);
      expect((concise.conversations as Row[])[0]).toEqual({
        id: billing,
        status: 'open',
        contact: { id: minjiContact, name: 'Minji' },
        assignee: { userId: ada, name: 'Ada' },
        preview: 'Refunded, receipt attached',
        lastMessageAt: expect.any(String),
        isUnread: false,
      });
      expect((concise.conversations as Row[])[1]).toMatchObject({ assignee: null, isUnread: true });
      expect(concise).not.toHaveProperty('nextBefore');
      expect((detailed.conversations as Row[])[0]).toMatchObject({
        category: 'billing',
        createdAt: expect.any(String),
        contact: { id: minjiContact, name: 'Minji', email: 'Minji@Shop.test', externalUserId: 'minji-1' },
      });
    });

    it('filters by status, assignee and contact', async () => {
      expect(idsOf(await search({ status: 'closed' }))).toEqual([closed]);
      expect(idsOf(await search({ status: 'all' }))).toEqual([billing, closed, crash]);
      expect(idsOf(await search({ assignee: 'me' }))).toEqual([billing]);
      expect(idsOf(await search({ assignee: ada }))).toEqual([billing]);
      expect(idsOf(await search({ assignee: bo }))).toEqual([]);
      expect(idsOf(await search({ assignee: 'unassigned' }))).toEqual([crash]);
      // A contact by email in any case, by the app's user id, or by id.
      expect(idsOf(await search({ contact: 'minji@shop.test', status: 'all' }))).toEqual([billing, closed]);
      expect(idsOf(await search({ contact: 'jun-7' }))).toEqual([crash]);
      expect(idsOf(await search({ contact: minjiContact }))).toEqual([billing]);
    });

    it('pages by latest activity, and says where the next page starts only when there is one', async () => {
      const first = await search({ status: 'all', limit: 2 });
      const second = await search({ status: 'all', limit: 2, before: first.nextBefore });

      expect(idsOf(first)).toEqual([billing, closed]);
      expect(first.nextBefore).toEqual(expect.any(String));
      expect(idsOf(second)).toEqual([crash]);
      expect(second).not.toHaveProperty('nextBefore');
    });

    it("never lists another workspace's conversations, even by their contact", async () => {
      const answer = await search({ status: 'all', contact: 'minji-1' });

      expect(idsOf(answer)).not.toContain(foreign);
      expect(JSON.stringify(answer)).not.toContain('Their');
    });
  });

  describe('mocco_messenger_conversation_get', () => {
    it("reads the thread with notes marked and the attachments' metadata, never a link", async () => {
      const answer = await call('mocco_messenger_conversation_get', { conversationId: billing });
      const body = bodyOf(answer);

      expect(body.conversation).toMatchObject({
        id: billing,
        status: 'open',
        category: 'billing',
        assignee: { userId: ada, name: 'Ada' },
      });
      expect(body.contact).toEqual({ id: minjiContact, name: 'Minji', isBlocked: false });
      expect(body.earlierMessages).toBe(0);
      expect(body.messages).toEqual([
        expect.objectContaining({ seq: 1, from: 'contact', authorName: null, isNote: false, attachments: [] }),
        expect.objectContaining({
          seq: 2,
          from: 'operator',
          authorName: 'Ada',
          isNote: false,
          body: 'Refunded, receipt attached',
          attachments: [
            { id: expect.any(String), filename: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 15 },
          ],
        }),
        expect.objectContaining({ seq: 3, isNote: true, body: 'Checked Stripe: duplicate charge' }),
      ]);
      // The service signed a download link for the console; none of it reaches the agent.
      const consoleRead = await messenger.inbox.get(mine.workspaceId, mine.projectId, billing);
      expect(JSON.stringify(consoleRead)).toContain('storage.test');
      expect(textOf(answer)).not.toContain('storage.test');
      expect(textOf(answer)).not.toContain('"url"');
    });

    it('returns the latest messages, counts the rest, and adds the contact when detailed', async () => {
      const body = bodyOf(
        await call('mocco_messenger_conversation_get', {
          conversationId: billing,
          limit: 1,
          responseFormat: 'detailed',
        }),
      );

      expect(body.earlierMessages).toBe(2);
      expect((body.messages as Row[]).map(message => message.seq)).toEqual([3]);
      expect(body.contact).toMatchObject({ email: 'Minji@Shop.test', externalUserId: 'minji-1', traits: {} });
      expect(body.conversation).toHaveProperty('contextAtOpen');
      expect(textOf(await call('mocco_messenger_conversation_get', { conversationId: billing }))).not.toContain(
        'Minji@Shop.test',
      );
    });

    it("refuses another workspace's conversation exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const theirsAnswer = await call('mocco_messenger_conversation_get', { conversationId: foreign });
      const missing = await call('mocco_messenger_conversation_get', { conversationId: nowhere });
      const throughTheirProject = await call('mocco_messenger_conversation_get', {
        conversationId: foreign,
        projectId: theirs.projectId,
      });
      const throughTheirWorkspace = await call('mocco_messenger_conversation_get', {
        conversationId: foreign,
        workspaceId: theirs.workspaceId,
      });

      expect(theirsAnswer.result?.isError).toBe(true);
      expect(textOf(theirsAnswer)).toContain('was not found');
      expect(textOf(theirsAnswer).replace(foreign, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(throughTheirProject.result?.isError).toBe(true);
      expect(textOf(throughTheirProject)).not.toContain('Their secret question');
      expect(throughTheirWorkspace.result?.isError).toBe(true);
      expect(textOf(throughTheirWorkspace)).not.toContain('Their secret question');
    });

    it('refuses where the messenger product is off, as the console does', async () => {
      await project.products.disable(mine.workspaceId, Products.messenger);

      const read = await call('mocco_messenger_conversation_get', { conversationId: billing });
      const searched = await call('mocco_messenger_conversations_search', {});

      expect([read.result?.isError, searched.result?.isError]).toEqual([true, true]);
      expect(textOf(read)).toContain('not enabled');
    });
  });

  describe('mocco_messenger_reply', () => {
    const REPLY = 'mocco_messenger_reply';

    it('asks first, showing the exact text and who reads it, and writes nothing until answered', async () => {
      const { asked } = await ask(REPLY, { conversationId: crash, body: 'Fixed in 2.4.1, please update' });

      expect(messageOf(asked)).toContain('Send this reply to Jun, as you?');
      expect(messageOf(asked)).toContain('Fixed in 2.4.1, please update');
      expect(await messagesIn(crash)).toHaveLength(1);
    });

    it('sends the reply as the person once confirmed, exactly as the console does', async () => {
      const body = bodyOf(await confirmed(REPLY, { conversationId: crash, body: 'Fixed in 2.4.1, please update' }));

      expect(body).toMatchObject({ changed: true, conversationId: crash, seq: 2 });
      const messages = await messagesIn(crash);
      const written = messages.find(message => message.seq === 2);
      expect(written).toMatchObject({
        authorKind: 'operator',
        authorUserId: ada,
        visibility: 'public',
        body: 'Fixed in 2.4.1, please update',
      });
    });

    it('sends nothing when the person says no', async () => {
      const body = bodyOf(await confirmed(REPLY, { conversationId: crash, body: 'Hello' }, false));

      expect(body).toMatchObject({ changed: false });
      expect(await messagesIn(crash)).toHaveLength(1);
    });

    it('sends once when the same confirmation is answered twice, and refuses it for other text', async () => {
      const args = { conversationId: crash, body: 'Fixed in 2.4.1' };
      const { requestState } = await ask(REPLY, args);
      const round = { requestState, inputResponses: accepting(true) };

      const other = await call(REPLY, { ...args, body: 'Something else' }, WITH_MESSENGER_WRITE, round);
      const first = await call(REPLY, args, WITH_MESSENGER_WRITE, round);
      const again = await call(REPLY, args, WITH_MESSENGER_WRITE, round);

      expect(other.result?.isError).toBe(true);
      expect(textOf(other)).toContain('different change');
      expect(bodyOf(first)).toMatchObject({ changed: true });
      // The reply moved the conversation on, so the old confirmation no longer matches.
      expect(again.result?.isError).toBe(true);
      const messages = await messagesIn(crash);
      expect(messages.map(message => message.body)).toEqual(['The app crashes on launch', 'Fixed in 2.4.1']);
    });

    it('refuses in a workspace that has not allowed agents to make changes, and says where to change it', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);

      const answer = await call(REPLY, { conversationId: crash, body: 'Hello' }, WITH_MESSENGER_WRITE);

      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.resultType).not.toBe('input_required');
      expect(textOf(answer)).toContain('Agents may not reply in the messenger in this workspace');
      expect(textOf(answer)).toContain('Settings → Agents');
      expect(await messagesIn(crash)).toHaveLength(1);
    });

    it('challenges a token without messenger:write for it, keeping the scopes it has, and writes nothing', async () => {
      const answer = await call(REPLY, { conversationId: crash, body: 'Hello' });
      // Neither approvals:write nor status:write is messenger:write.
      const deciding = await call(REPLY, { conversationId: crash, body: 'Hello' }, [...SIGN_IN, 'approvals:write']);

      expect(answer.status).toBe(403);
      expect(answer.wwwAuthenticate).toContain('error="insufficient_scope"');
      expect(answer.wwwAuthenticate).toContain('scope="messenger:write openid profile email offline_access"');
      expect(deciding.status).toBe(403);
      expect(deciding.wwwAuthenticate).toContain(
        'scope="messenger:write openid profile email offline_access approvals:write"',
      );
      expect(await messagesIn(crash)).toHaveLength(1);
    });

    it("refuses another workspace's conversation before asking anything, exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const theirsAnswer = await call(REPLY, { conversationId: foreign, body: 'Hi' }, WITH_MESSENGER_WRITE);
      const missing = await call(REPLY, { conversationId: nowhere, body: 'Hi' }, WITH_MESSENGER_WRITE);
      const asEve = await call(
        REPLY,
        { conversationId: foreign, body: 'Hi', workspaceId: mine.workspaceId },
        WITH_MESSENGER_WRITE,
        {},
        eve,
      );

      expect(theirsAnswer.result?.resultType).not.toBe('input_required');
      expect(theirsAnswer.result?.isError).toBe(true);
      expect(textOf(theirsAnswer).replace(foreign, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      // Eve is not in this workspace at all.
      expect(asEve.result?.isError).toBe(true);
      expect(await messagesIn(foreign)).toHaveLength(1);
    });
  });

  describe('mocco_messenger_assign', () => {
    const ASSIGN = 'mocco_messenger_assign';

    it('asks first, naming who has it and who takes it, and moves nothing until answered', async () => {
      const { asked } = await ask(ASSIGN, { conversationId: billing, assignee: bo });

      expect(messageOf(asked)).toContain('conversation with Minji');
      expect(messageOf(asked)).toContain('From: Ada');
      expect(messageOf(asked)).toContain('To: Bo (bo@acme.test)');
      expect(await assigneeOf(billing)).toBe(ada);
    });

    it('hands the conversation over once confirmed, recorded as the person', async () => {
      const body = bodyOf(await confirmed(ASSIGN, { conversationId: billing, assignee: bo }));

      expect(body).toEqual({ conversationId: billing, assignee: { userId: bo, name: 'Bo' }, changed: true });
      expect(await assigneeOf(billing)).toBe(bo);
      const [entry] = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, AuditActions.messengerConversationAssigned));
      expect(entry).toMatchObject({
        actorUserId: ada,
        subjectId: billing,
        payload: { projectId: mine.projectId, from: ada, to: bo },
      });
    });

    it('takes an unassigned one for the caller, and gives one to no one', async () => {
      bodyOf(await confirmed(ASSIGN, { conversationId: crash, assignee: 'me' }));
      bodyOf(await confirmed(ASSIGN, { conversationId: billing, assignee: 'unassigned' }));

      expect(await assigneeOf(crash)).toBe(ada);
      expect(await assigneeOf(billing)).toBeNull();
    });

    it('moves nothing when the person says no', async () => {
      const body = bodyOf(await confirmed(ASSIGN, { conversationId: billing, assignee: bo }, false));

      expect(body).toMatchObject({ changed: false });
      expect(await assigneeOf(billing)).toBe(ada);
    });

    it('says so without asking when it is theirs already', async () => {
      const answer = await call(ASSIGN, { conversationId: billing, assignee: 'me' }, WITH_MESSENGER_WRITE);

      expect(answer.result?.resultType).not.toBe('input_required');
      expect(bodyOf(answer)).toMatchObject({ changed: false, assignee: { userId: ada } });
    });

    it('refuses someone outside the workspace before asking anything', async () => {
      const answer = await call(ASSIGN, { conversationId: billing, assignee: eve }, WITH_MESSENGER_WRITE);

      expect(answer.result?.resultType).not.toBe('input_required');
      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain("isn't a member of this workspace");
      expect(await assigneeOf(billing)).toBe(ada);
    });

    it("refuses one conversation's confirmation for another, and when someone else moved it meanwhile", async () => {
      const { requestState } = await ask(ASSIGN, { conversationId: billing, assignee: bo });
      const round = { requestState, inputResponses: accepting(true) };

      const replayed = await call(ASSIGN, { conversationId: crash, assignee: bo }, WITH_MESSENGER_WRITE, round);
      await messenger.inbox.assign(mine.workspaceId, mine.projectId, bo, {
        conversationId: billing,
        assigneeUserId: null,
      });
      const stale = await call(ASSIGN, { conversationId: billing, assignee: bo }, WITH_MESSENGER_WRITE, round);

      expect(textOf(replayed)).toContain('different change');
      expect(textOf(stale)).toContain('different change');
      expect(await assigneeOf(crash)).toBeNull();
      expect(await assigneeOf(billing)).toBeNull();
    });

    it('refuses in a workspace that has not allowed agents to make changes', async () => {
      await settings.setAgentsMayDecide(mine.workspaceId, false, ada);

      const answer = await call(ASSIGN, { conversationId: billing, assignee: bo }, WITH_MESSENGER_WRITE);

      expect(answer.result?.resultType).not.toBe('input_required');
      expect(textOf(answer)).toContain('Agents may not assign conversations in this workspace');
      expect(await assigneeOf(billing)).toBe(ada);
    });

    it('challenges a token without messenger:write for it', async () => {
      const answer = await call(ASSIGN, { conversationId: billing, assignee: bo }, [...SIGN_IN, 'status:write']);

      expect(answer.status).toBe(403);
      expect(answer.wwwAuthenticate).toContain(
        'scope="messenger:write openid profile email offline_access status:write"',
      );
      expect(await assigneeOf(billing)).toBe(ada);
    });

    it("refuses another workspace's conversation exactly as one that does not exist", async () => {
      const nowhere = randomUUID();

      const theirsAnswer = await call(ASSIGN, { conversationId: foreign, assignee: 'me' }, WITH_MESSENGER_WRITE);
      const missing = await call(ASSIGN, { conversationId: nowhere, assignee: 'me' }, WITH_MESSENGER_WRITE);

      expect(theirsAnswer.result?.isError).toBe(true);
      expect(textOf(theirsAnswer).replace(foreign, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
      expect(await assigneeOf(foreign)).toBeNull();
    });
  });

  it('marks the reads read-only and the changes as changes', async () => {
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

    expect(hintsOf('mocco_messenger_conversations_search')).toMatchObject({ readOnlyHint: true });
    expect(hintsOf('mocco_messenger_conversation_get')).toMatchObject({ readOnlyHint: true });
    expect(hintsOf('mocco_messenger_reply')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hintsOf('mocco_messenger_assign')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
