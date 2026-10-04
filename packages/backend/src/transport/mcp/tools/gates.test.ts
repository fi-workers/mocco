// `mocco_gates_resume` over a real database, through the real HTTP handler.
//
// Like the vote's tests, these send the requests a client sends — the scope challenge,
// the signed confirmation state and the SDK seam that verifies it are part of what is
// being proven — and the run they act on is triggered and paused by the real services.
import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { ExecutorIds } from '@mocco/common/execution';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createTestEventBus } from '@backend/domain/events/testing/event-bus';
import { RunEventRepo } from '@backend/domain/execution/repos/run-event.repo';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunService } from '@backend/domain/execution/RunService';
import { FakeExecutor } from '@backend/domain/execution/testing/fake-executor';
import { GateService } from '@backend/domain/governance/GateService';
import { ResumeRepo } from '@backend/domain/governance/repos/resume.repo';
import { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import { RoleRepo } from '@backend/domain/governance/repos/role.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { createMcpSettingsService } from '@backend/domain/mcp/instance';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { expectOne } from '@backend/infra/db/rows';
import { members, providerConnections, repos, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createConfirmations } from '@backend/transport/mcp/confirmation';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { RESUME_TOOL } from '@backend/transport/mcp/tools/gates';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { McpSettingsService } from '@backend/domain/mcp/McpSettingsService';
import type { GateItem, MoccoConfig } from '@mocco/common/mocco-config';
import type { McpHttpHandler } from '@modelcontextprotocol/server';

const PROTOCOL_VERSION = '2026-07-28';
const RESOURCE = 'https://mocco.test/api/mcp';
const SIGN_IN = ['openid', 'profile', 'email', 'offline_access'];
const WITH_WRITE = [...SIGN_IN, 'approvals:write'];

const envelope = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
};

const refuse = () => {
  throw new Error('the resume tool must not reach another service');
};

interface Caller {
  userId: string;
  scopes?: string[];
  clientId?: string;
}

interface Round {
  requestState?: string;
  inputResponses?: Record<string, unknown>;
}

interface RpcAnswer {
  status: number;
  wwwAuthenticate: string | null;
  result?: {
    resultType?: string;
    isError?: boolean;
    content?: { type: string; text: string }[];
    inputRequests?: Record<string, { method: string; params: { message: string } }>;
    requestState?: string;
  };
  error?: { code: number; message: string };
}

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

/** The person's answer to the confirmation, as a client sends it back. */
const accepting = (isConfirmed: boolean) => ({ confirm: { action: 'accept', content: { confirm: isConfirmed } } });

const GATE: Omit<GateItem, 'kind'> = {
  name: 'production',
  resume: [{ role: 'release', count: 1 }],
  prevent_self: true,
};

describe('mocco_gates_resume (pglite, over HTTP)', () => {
  let t: TestDb;
  let audit: AuditService;
  let settings: McpSettingsService;
  let runService: RunService;
  let handler: McpHttpHandler;
  let workspaceId: string;
  let ada: string;
  let triggerer: string;

  async function addUser(...roleNames: string[]): Promise<string> {
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'U', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    await t.db.insert(members).values({ organizationId: workspaceId, userId, role: 'member' });
    const roles = new RoleRepo(t.db);
    const memberships = new RoleMembershipRepo(t.db);
    const existing = await roles.listByWorkspace(workspaceId);
    await Promise.all(
      roleNames.map(async name => {
        const role = existing.find(each => each.name === name) ?? (await roles.create({ workspaceId, name }));
        await memberships.add({ workspaceId, roleId: role.id, userId });
      }),
    );
    return userId;
  }

  /** A run of fi-workers/api whose first item is the gate, so it pauses at item 0. */
  async function pausedRun(): Promise<string> {
    const connection = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'fi-workers' })
        .returning(),
    );
    const repo = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: connection.id,
          externalRepoId: randomUUID(),
          owner: 'fi-workers',
          name: 'api',
          defaultBranch: 'main',
        })
        .returning(),
    );
    const commits = new CommitRepo(t.db);
    await commits.upsertMany([
      {
        repoId: repo.id,
        sha: 'c0ffee1234',
        branch: 'release/3.0',
        message: 'Add the billing migration\n\nLong body.',
        authorName: 'Author',
        authorEmail: 'author@example.com',
        committedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const [commit] = await commits.listByRepo(repo.id, null, 1);
    if (commit === undefined) {
      throw new Error('expected the seeded commit');
    }
    const config: MoccoConfig = {
      version: 2,
      pipeline: 'deploy',
      steps: [
        { kind: 'gate', ...GATE },
        { kind: 'step', run: 'ship', executor: 'generic' },
      ],
    };
    await new CommitConfigRepo(t.db).upsert({
      commitId: commit.id,
      present: true,
      rawYaml: 'version: 2',
      parsedJson: config,
      valid: true,
      validationErrors: [],
    });
    const run = await runService.trigger(workspaceId, commit.id, triggerer);
    expect(run.state).toBe('awaiting_gate');
    return run.id;
  }

  async function call(caller: Caller, args: Record<string, unknown>, round: Round = {}): Promise<RpcAnswer> {
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': RESUME_TOOL,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: RESUME_TOOL, arguments: args, _meta: envelope, ...round },
      }),
    });
    const response = await handler.fetch(request, {
      authInfo: {
        token: '',
        clientId: caller.clientId ?? 'agent',
        scopes: caller.scopes ?? WITH_WRITE,
        resource: new URL(RESOURCE),
        extra: { [MCP_USER_ID]: caller.userId },
      },
    });
    const text = await response.text();
    const body = (text === '' ? {} : JSON.parse(text)) as Omit<RpcAnswer, 'status' | 'wwwAuthenticate'>;
    return { status: response.status, wwwAuthenticate: response.headers.get('www-authenticate'), ...body };
  }

  /** The first round, which must ask; returns the state to echo. */
  async function ask(caller: Caller, args: Record<string, unknown>): Promise<string> {
    const asked = await call(caller, args);
    expect(asked.result?.resultType).toBe('input_required');
    const state = asked.result?.requestState;
    expect(state).toEqual(expect.any(String));
    return state ?? '';
  }

  /** Ask, then answer yes — the whole confirmed decision. */
  async function confirmed(caller: Caller, args: Record<string, unknown>): Promise<RpcAnswer> {
    const requestState = await ask(caller, args);
    return await call(caller, args, { requestState, inputResponses: accepting(true) });
  }

  const votesOn = async (runId: string) => await new ResumeRepo(t.db).listByRun(workspaceId, runId);
  const runState = async (runId: string) => {
    const run = await new RunRepo(t.db).getByIdInWorkspace(workspaceId, runId);
    return run.state;
  };

  beforeEach(async () => {
    t = await createTestDb();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    settings = createMcpSettingsService(t.db, audit);
    runService = new RunService({
      bus: createTestEventBus(t.db),
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      events: new RunEventRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      commits: new CommitRepo(t.db),
      configs: new CommitConfigRepo(t.db),
      executors: new Map([[ExecutorIds.generic, new FakeExecutor()]]),
      callbackUrl: 'http://localhost:3100/api/ext/callback',
      audit,
      waitUntil: () => {
        /* the outbound trigger is fire-and-forget; the FakeExecutor records synchronously */
      },
    });
    const gates = new GateService({
      bus: createTestEventBus(t.db),
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runService.resumeFromGate(run, gateItemIndex),
      audit,
    });
    workspaceId = expectOne(await t.db.insert(workspaces).values({ name: 'Acme', slug: randomUUID() }).returning()).id;
    ada = await addUser('release');
    triggerer = await addUser('release');
    await settings.setAgentsMayDecide(workspaceId, true, ada);
    handler = createMcpHttpHandler({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals: { list: refuse, get: refuse, vote: refuse },
      gates,
      scope: new WorkspaceScope({ memberships: new MembershipRepo(t.db) }),
      settings,
      flags: { listFlags: refuse, listEnvironments: refuse, history: refuse },
      projects: { resolve: refuse },
      otaHosting: { listApps: refuse, requireApp: refuse, listChannels: refuse },
      otaChannels: { listHeads: refuse },
      otaReleases: { listReleases: refuse },
      otaMetrics: { channelReach: refuse, monthlyActiveDevices: refuse },
      versionPolicies: { get: refuse, listChanges: refuse },
      projectApps: { listApps: refuse },
      statusPages: { listPages: refuse, getPage: refuse },
      statusIncidents: { list: refuse, get: refuse },
      statusMaintenances: { list: refuse },
      confirmations: createConfirmations('a-test-secret-that-is-only-used-here'),
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('challenges a token without approvals:write for it, keeping the scopes it has', async () => {
    const runId = await pausedRun();

    const answer = await call({ userId: ada, scopes: SIGN_IN }, { runId, gateItemIndex: 0, decision: 'resume' });

    expect(answer.status).toBe(403);
    expect(answer.wwwAuthenticate).toContain('error="insufficient_scope"');
    expect(answer.wwwAuthenticate).toContain('scope="approvals:write openid profile email offline_access"');
    expect(await votesOn(runId)).toEqual([]);
  });

  it('refuses in a workspace that has not allowed agents to decide, and says where to change it', async () => {
    await settings.setAgentsMayDecide(workspaceId, false, ada);
    const runId = await pausedRun();

    const answer = await call({ userId: ada }, { runId, gateItemIndex: 0, decision: 'resume' });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('Agents may not resume or reject runs in this workspace');
    expect(textOf(answer)).toContain('Settings → Agents');
    expect(await votesOn(runId)).toEqual([]);
  });

  it('asks first: the confirmation names the run, the gate and the decision, and nothing is recorded', async () => {
    const runId = await pausedRun();

    const answer = await call({ userId: ada }, { runId, gateItemIndex: 0, decision: 'resume', reason: 'smoke ok' });

    expect(answer.result?.resultType).toBe('input_required');
    const confirm = answer.result?.inputRequests?.confirm;
    expect(confirm?.method).toBe('elicitation/create');
    const message = confirm?.params.message ?? '';
    expect(message).toContain('Resume this run past its gate as you?');
    expect(message).toContain('Repository: fi-workers/api');
    expect(message).toContain('Commit: c0ffee1234 on release/3.0 — Add the billing migration');
    expect(message).not.toContain('Long body');
    expect(message).toContain('Gate: production (item 0)');
    expect(message).toContain('Requires: 1 × release; not the person who triggered the run');
    expect(message).toContain('Reason: smoke ok');
    expect(message).toContain(`Run: ${runId}`);
    expect(await votesOn(runId)).toEqual([]);
    expect(await runState(runId)).toBe('awaiting_gate');
  });

  it('says a reject halts the run', async () => {
    const runId = await pausedRun();

    const answer = await call({ userId: ada }, { runId, gateItemIndex: 0, decision: 'reject' });

    expect(answer.result?.inputRequests?.confirm?.params.message).toContain('Rejecting halts the run');
  });

  it('resumes once confirmed, as the caller, and the audit chain names them', async () => {
    const runId = await pausedRun();

    const answer = await confirmed({ userId: ada }, { runId, gateItemIndex: 0, decision: 'resume' });

    expect(answer.result?.isError).not.toBe(true);
    expect(JSON.parse(textOf(answer))).toMatchObject({
      recorded: true,
      runId,
      run: 'running',
      gate: { name: 'production', state: 'resumed' },
    });
    const votes = await votesOn(runId);
    expect(votes.map(vote => [vote.userId, vote.decision])).toEqual([[ada, 'resume']]);
    const entries = await audit.list(workspaceId, 0n);
    const resumed = entries.filter(entry => entry.action === AuditActions.gateResumed);
    expect(resumed.map(entry => entry.actorUserId)).toEqual([ada]);
  });

  it('rejects once confirmed, which halts the run', async () => {
    const runId = await pausedRun();

    const answer = await confirmed({ userId: ada }, { runId, gateItemIndex: 0, decision: 'reject', reason: 'no' });

    expect(JSON.parse(textOf(answer))).toMatchObject({ recorded: true, run: 'rejected' });
    const entries = await audit.list(workspaceId, 0n);
    expect(entries.find(entry => entry.action === AuditActions.gateRejected)?.actorUserId).toBe(ada);
  });

  it('records nothing when the person declines, cancels or answers no', async () => {
    const runId = await pausedRun();
    const args = { runId, gateItemIndex: 0, decision: 'resume' };

    const answers = await Promise.all(
      [{ confirm: { action: 'decline' } }, { confirm: { action: 'cancel' } }, accepting(false)].map(
        async inputResponses => {
          const requestState = await ask({ userId: ada }, args);
          return await call({ userId: ada }, args, { requestState, inputResponses });
        },
      ),
    );

    expect(answers.map(answer => JSON.parse(textOf(answer)) as unknown)).toEqual([
      expect.objectContaining({ recorded: false }),
      expect.objectContaining({ recorded: false }),
      expect.objectContaining({ recorded: false }),
    ]);
    expect(await votesOn(runId)).toEqual([]);
    expect(await runState(runId)).toBe('awaiting_gate');
  });

  it('refuses a state that was tampered with', async () => {
    const runId = await pausedRun();
    const args = { runId, gateItemIndex: 0, decision: 'resume' };
    const requestState = await ask({ userId: ada }, args);
    const [version, body = '', mac] = requestState.split('.');
    const forged = [version, `${body.slice(0, -2)}AA`, mac].join('.');

    const answer = await call({ userId: ada }, args, { requestState: forged, inputResponses: accepting(true) });

    expect(answer.error?.code).toBe(-32_602);
    expect(await votesOn(runId)).toEqual([]);
  });

  it('refuses a state minted for someone else, or for another app of the same person', async () => {
    const runId = await pausedRun();
    const args = { runId, gateItemIndex: 0, decision: 'resume' };
    const bob = await addUser('release');
    const requestState = await ask({ userId: bob }, args);

    const asAda = await call({ userId: ada }, args, { requestState, inputResponses: accepting(true) });
    const fromAnotherApp = await call({ userId: bob, clientId: 'other-agent' }, args, {
      requestState,
      inputResponses: accepting(true),
    });

    expect(asAda.error?.code).toBe(-32_602);
    expect(fromAnotherApp.error?.code).toBe(-32_602);
    expect(await votesOn(runId)).toEqual([]);
  });

  it('refuses a confirmation of one decision carried into another', async () => {
    const runId = await pausedRun();
    const requestState = await ask({ userId: ada }, { runId, gateItemIndex: 0, decision: 'reject' });

    const answer = await call(
      { userId: ada },
      { runId, gateItemIndex: 0, decision: 'resume' },
      { requestState, inputResponses: accepting(true) },
    );

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('different decision');
    expect(await votesOn(runId)).toEqual([]);
    expect(await runState(runId)).toBe('awaiting_gate');
  });

  it('refuses a gate the run is not paused at, before asking', async () => {
    const runId = await pausedRun();

    const elsewhere = await call({ userId: ada }, { runId, gateItemIndex: 1, decision: 'resume' });
    const unknown = await call({ userId: ada }, { runId: randomUUID(), gateItemIndex: 0, decision: 'resume' });

    expect([elsewhere, unknown].map(answer => answer.result?.isError)).toEqual([true, true]);
    expect(textOf(elsewhere)).toContain('mocco_runs_get shows what it is waiting on');
    expect(textOf(unknown)).toContain('mocco_runs_get shows what it is waiting on');
    expect(await votesOn(runId)).toEqual([]);
  });

  it('refuses a confirmed decision on a gate that was settled after it was asked', async () => {
    const runId = await pausedRun();
    const args = { runId, gateItemIndex: 0, decision: 'resume' };
    const requestState = await ask({ userId: ada }, args);
    const bob = await addUser('release');
    await confirmed({ userId: bob }, args);

    const answer = await call({ userId: ada }, args, { requestState, inputResponses: accepting(true) });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('No pending gate at index 0');
    const votes = await votesOn(runId);
    expect(votes.map(vote => vote.userId)).toEqual([bob]);
  });

  it('will not let the person who triggered the run resume it', async () => {
    const runId = await pausedRun();

    const answer = await confirmed({ userId: triggerer }, { runId, gateItemIndex: 0, decision: 'resume' });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('cannot resume a gate on a run you triggered');
    expect(await votesOn(runId)).toEqual([]);
  });

  it('still lets the role check refuse someone the gate does not allow', async () => {
    const runId = await pausedRun();
    const outsider = await addUser();

    const answer = await confirmed({ userId: outsider }, { runId, gateItemIndex: 0, decision: 'resume' });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('not in a role authorized to resume');
    expect(await votesOn(runId)).toEqual([]);
    expect(await runState(runId)).toBe('awaiting_gate');
  });
});
