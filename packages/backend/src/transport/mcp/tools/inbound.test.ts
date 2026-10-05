// `mocco_inbound_sources_search` over a real database, through the real HTTP handler.
//
// A source holds a signing secret, so most of these tests are about what never comes
// back: neither the secret Mocco generated nor the one a customer pasted nor its sealed
// form, in either shape. A workspace the caller is not in reads the same whether it
// exists or not, and a server without `SECRETS_ENCRYPTION_KEYS` says why it cannot answer.
import { randomUUID } from 'node:crypto';

import { InboundKinds, InboundOutcomes, InboundSourceStatuses } from '@mocco/common/inbound';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createInboundHarness, ingestKeyOf, signedDelivery } from '@backend/domain/inbound/testing/harness';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { seedWorkspace } from '@backend/domain/notification/testing/seed';
import { expectOne } from '@backend/infra/db/rows';
import { inboundSources, members, users } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { McpToolDeps } from '@backend/transport/mcp/server';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';
const TOOL = 'mocco_inbound_sources_search';

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const refuse = () => {
  throw new Error('the inbound tool must not reach another domain');
};

interface RpcAnswer {
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
  };
}

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

/** A successful answer's JSON; fails the test on a refusal, showing why. */
function bodyOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Record<string, unknown>;
}

type Row = Record<string, unknown>;

const SENTRY_SECRET = 'sentry-client-secret-do-not-leak';

const otherDeps = (scope: WorkspaceScope): Omit<McpToolDeps, 'inbound'> => ({
  runs: { searchInWorkspace: refuse, get: refuse },
  approvals: { list: refuse, get: refuse, vote: refuse },
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
  statusMonitors: { list: refuse, get: refuse },
  statusLocations: { list: refuse },
  statusCorrelation: { list: refuse },
  helpPublic: { searchInProject: refuse, siteInProject: refuse, articleInProject: refuse },
  helpFeedback: { helpfulness: refuse },
  notifications: {
    listGuilds: refuse,
    listGuildChannels: refuse,
    listChannels: refuse,
    listRules: refuse,
    createChannel: refuse,
    reenableChannel: refuse,
    addRule: refuse,
    removeRule: refuse,
    applyDefaultRules: refuse,
  },
  notificationActivity: { list: refuse },
  scope,
  projects: { resolve: refuse, resolveWorkspace: refuse },
  settings: { agentsMayDecide: refuse },
  confirmations: undefined,
});

describe('mocco_inbound_sources_search (pglite, over HTTP)', () => {
  let t: TestDb;
  let handler: McpHttpHandler;
  let scope: WorkspaceScope;
  let bob: string;
  let theirs: string;
  let github: { id: string; ingestUrl: string };
  let sentry: { id: string; ingestUrl: string };
  let vercel: { id: string };
  let generatedSecret: string;
  let sealed: string[];

  async function rpc(method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
    const name = typeof params.name === 'string' ? params.name : undefined;
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': method,
        ...(name !== undefined && { 'mcp-name': name }),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: envelope } }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: 'agent',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: bob },
      },
    });
    const text = await response.text();
    return (text === '' ? {} : JSON.parse(text)) as RpcAnswer;
  }

  /** Bob is a plain member, which is all listing sources takes in the console. */
  const call = async (args: Record<string, unknown>) => await rpc('tools/call', { name: TOOL, arguments: args });

  const idsOf = async (args: Record<string, unknown>) =>
    (bodyOf(await call(args)).sources as Row[]).map(source => source.id);

  beforeEach(async () => {
    t = await createTestDb();
    bob = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Bob', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    const mine = await seedWorkspace(t.db, 'Acme');
    theirs = await seedWorkspace(t.db, 'Globex');
    await t.db.insert(members).values({ organizationId: mine, userId: bob, role: 'member' });

    // GitHub (Mocco generated its secret), Sentry (a pasted one) and a paused Vercel.
    const inbound = createInboundHarness(t.db);
    const createdGithub = await inbound.sources.create(mine, bob, { kind: InboundKinds.github, name: 'Acme repo' });
    generatedSecret = createdGithub.generatedSecret ?? '';
    github = createdGithub.source;
    ({ source: sentry } = await inbound.sources.create(mine, bob, {
      kind: InboundKinds.sentry,
      name: 'Acme errors',
      secret: SENTRY_SECRET,
    }));
    ({ source: vercel } = await inbound.sources.create(mine, bob, {
      kind: InboundKinds.vercel,
      name: 'Acme web',
      secret: 'vercel-secret-do-not-leak',
    }));
    await inbound.sources.pause(mine, bob, vercel.id);
    await inbound.sources.create(theirs, bob, { kind: InboundKinds.sentry, name: 'Their secret source', secret: 'x' });
    // Sources made in the same instant tie on created_at; space them out.
    await Promise.all(
      [github.id, sentry.id, vercel.id].map(async (id, index) => {
        await t.db
          .update(inboundSources)
          .set({ createdAt: new Date(Date.now() + index * 1000) })
          .where(eq(inboundSources.id, id));
      }),
    );
    const rows = await t.db.select().from(inboundSources);
    sealed = rows.map(row => row.secretSealed);

    // Sentry delivers an issue (published); GitHub sends a ping (ignored).
    await inbound.inbound.ingest({
      ingestKey: ingestKeyOf(sentry.ingestUrl),
      ...signedDelivery(InboundKinds.sentry, SENTRY_SECRET),
    });
    const ping = signedDelivery(InboundKinds.github, generatedSecret);
    ping.headers.set('x-github-event', 'ping');
    await inbound.inbound.ingest({ ingestKey: ingestKeyOf(github.ingestUrl), ...ping });

    scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    handler = createMcpHttpHandler({ ...otherDeps(scope), inbound });
  });
  afterEach(async () => {
    await t.close();
  });

  it('is declared read-only', async () => {
    const listed = await rpc('tools/list', {});

    expect(listed.result?.tools?.find(tool => tool.name === TOOL)?.annotations?.readOnlyHint).toBe(true);
  });

  it("lists a plain member's sources oldest first, concise unless asked", async () => {
    const body = bodyOf(await call({}));

    expect(body.sources).toEqual([
      {
        id: github.id,
        kind: InboundKinds.github,
        name: 'Acme repo',
        status: InboundSourceStatuses.active,
        lastReceivedAt: expect.any(String),
      },
      {
        id: sentry.id,
        kind: InboundKinds.sentry,
        name: 'Acme errors',
        status: InboundSourceStatuses.active,
        lastReceivedAt: expect.any(String),
      },
      {
        id: vercel.id,
        kind: InboundKinds.vercel,
        name: 'Acme web',
        status: InboundSourceStatuses.paused,
        lastReceivedAt: null,
      },
    ]);
    expect(body).not.toHaveProperty('nextAfter');
  });

  it("adds each source's latest delivery, whether a secret is stored and the ingest URL when asked", async () => {
    const body = bodyOf(await call({ responseFormat: 'detailed' }));
    const [repo, errors, web] = body.sources as Row[];

    expect(repo).toMatchObject({
      hasSecret: true,
      ingestUrl: github.ingestUrl,
      lastDelivery: { outcome: InboundOutcomes.ignored, sourceEvent: 'ping', eventType: null },
    });
    expect(errors).toMatchObject({
      lastDelivery: {
        receivedAt: expect.any(String),
        outcome: InboundOutcomes.published,
        reason: null,
        eventType: 'sentry.issue.created',
      },
    });
    expect(web).toMatchObject({ lastDelivery: null, createdAt: expect.any(String), updatedAt: expect.any(String) });
  });

  it('filters by service, status and name, and pages oldest first', async () => {
    expect(await idsOf({ kind: 'sentry' })).toEqual([sentry.id]);
    expect(await idsOf({ status: 'paused' })).toEqual([vercel.id]);
    expect(await idsOf({ query: 'ACME RE' })).toEqual([github.id]);

    const first = bodyOf(await call({ limit: 2 }));
    const second = bodyOf(await call({ limit: 2, after: first.nextAfter }));

    expect((first.sources as Row[]).map(source => source.id)).toEqual([github.id, sentry.id]);
    expect((second.sources as Row[]).map(source => source.id)).toEqual([vercel.id]);
    expect(second).not.toHaveProperty('nextAfter');
  });

  it('never answers with a signing secret, generated or pasted, or its sealed form', async () => {
    const conciseAnswer = await call({});
    const detailedAnswer = await call({ responseFormat: 'detailed' });
    bodyOf(conciseAnswer);
    bodyOf(detailedAnswer);
    const concise = textOf(conciseAnswer);
    const everything = `${concise}\n${textOf(detailedAnswer)}`;

    expect(everything).not.toContain(generatedSecret);
    expect(everything).not.toContain(SENTRY_SECRET);
    expect(everything).not.toContain('vercel-secret-do-not-leak');
    expect(sealed.filter(value => everything.includes(value))).toEqual([]);
    expect(everything).not.toMatch(/secretSealed|secret_sealed|generatedSecret|workspaceId/u);
    // The ingest URL is in the detailed shape only.
    expect(concise).not.toContain(ingestKeyOf(github.ingestUrl));
  });

  it('refuses a workspace the caller is not in exactly as one that does not exist', async () => {
    const nowhere = randomUUID();

    const existing = await call({ workspaceId: theirs });
    const missing = await call({ workspaceId: nowhere });

    expect(existing.result?.isError).toBe(true);
    expect(textOf(existing)).toContain('No workspace');
    expect(textOf(existing).replace(theirs, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
    expect(textOf(existing)).not.toContain('Their secret source');
  });

  it('says why when this server has no inbound webhooks', async () => {
    handler = createMcpHttpHandler({ ...otherDeps(scope), inbound: undefined });

    const answer = await call({});

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('Inbound webhooks are not configured on this Mocco server');
    expect(textOf(answer)).toContain('SECRETS_ENCRYPTION_KEYS');
  });
});
