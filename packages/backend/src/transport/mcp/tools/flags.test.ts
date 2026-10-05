// `mocco_flags_*` over a real database, through the real HTTP handler.
//
// The reads are only as safe as the scoping in front of them, so most of these tests are
// about what a caller cannot see: a workspace they are not in reads the same whether it
// exists or not, a project of another workspace reads the same as one that does not
// exist, and a workspace without the flags product says so.
import { randomUUID } from 'node:crypto';

import { ChangesetSources, FlagManagers } from '@mocco/common/flags';
import { Products } from '@mocco/common/project';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { MembershipRepo } from '@backend/domain/auth/repos/membership.repo';
import { createFlagsDomain } from '@backend/domain/flags/compose';
import { createApprovalService } from '@backend/domain/governance/instance';
import { ProjectScope } from '@backend/domain/mcp/ProjectScope';
import { WorkspaceScope } from '@backend/domain/mcp/WorkspaceScope';
import { createProjectDomain } from '@backend/domain/project/instance';
import { expectOne } from '@backend/infra/db/rows';
import { members, users, workspaces } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { createMcpHttpHandler } from '@backend/transport/mcp/server';
import { MCP_USER_ID } from '@backend/transport/mcp/tools/runs';

import type { FlagsDomain } from '@backend/domain/flags/compose';
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
  throw new Error('the flag tools must not reach another domain');
};

interface RpcAnswer {
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[];
  };
  error?: { code: number; message: string };
}

const textOf = (answer: RpcAnswer) => answer.result?.content?.map(each => each.text).join('\n') ?? '';

/** A successful answer's JSON; fails the test on a refusal, showing why. */
function bodyOf(answer: RpcAnswer): Record<string, unknown> {
  expect(answer.result?.isError, textOf(answer)).not.toBe(true);
  return JSON.parse(textOf(answer)) as Record<string, unknown>;
}

interface FlagRow {
  key: string;
  environments: Record<string, unknown>[];
  [field: string]: unknown;
}

const flagsOf = (answer: RpcAnswer) => bodyOf(answer).flags as FlagRow[];

describe('mocco_flags_* (pglite, over HTTP)', () => {
  let t: TestDb;
  let domain: FlagsDomain;
  let project: ProjectDomain;
  let handler: McpHttpHandler;
  let ada: string;
  let mine: string;
  let myProject: string;
  let theirs: string;
  let theirProject: string;
  let production: string;

  async function rpc(userId: string, method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
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
        extra: { [MCP_USER_ID]: userId },
      },
    });
    const text = await response.text();
    return (text === '' ? {} : JSON.parse(text)) as RpcAnswer;
  }

  const call = async (tool: string, args: Record<string, unknown>, userId = ada) =>
    await rpc(userId, 'tools/call', { name: tool, arguments: args });

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
    await project.products.enable(workspaceId, Products.flags, ada);
    const created = await project.projects.create(workspaceId, { name: 'Shop', handle: 'shop' });
    return { workspaceId, projectId: created.id };
  }

  async function versionOfProduction() {
    const environments = await domain.flags.listEnvironments(mine, myProject);
    return expectOne(environments.filter(each => each.id === production)).currentVersion;
  }

  async function addFlag(workspaceId: string, projectId: string, key: string, description: string | null = null) {
    await domain.flags.createBooleanFlag(workspaceId, projectId, ada, { key, description, lifecycle: 'temporary' });
  }

  beforeEach(async () => {
    t = await createTestDb();
    const audit = new AuditService({ audit: new AuditRepo(t.db) });
    const approvals = createApprovalService(t.db, audit);
    domain = createFlagsDomain(t.db, { audit, approvals });
    project = createProjectDomain(t.db);
    ada = expectOne(
      await t.db
        .insert(users)
        .values({ id: randomUUID(), name: 'Ada', email: `${randomUUID()}@acme.test`, emailVerified: true })
        .returning(),
    ).id;
    ({ workspaceId: mine, projectId: myProject } = await addWorkspace(ada));
    ({ workspaceId: theirs, projectId: theirProject } = await addWorkspace());

    await domain.flags.createEnvironment(mine, myProject, ada, { key: 'staging', name: 'Staging' });
    const created = await domain.flags.createEnvironment(mine, myProject, ada, {
      key: 'production',
      name: 'Production',
    });
    production = created.id;
    await addFlag(mine, myProject, 'new-checkout', 'The one-page checkout');
    await addFlag(mine, myProject, 'dark-mode');
    await domain.flags.createFlag(
      mine,
      myProject,
      ada,
      {
        key: 'pricing-v2',
        type: 'string',
        variants: { old: 'old', new: 'new' },
        defaultVariant: 'old',
        offVariant: 'old',
        description: null,
        lifecycle: 'permanent',
      },
      { managedBy: FlagManagers.repo, clientVisible: false, source: ChangesetSources.repo },
    );
    await addFlag(theirs, theirProject, 'their-secret-flag');

    const scope = new WorkspaceScope({ memberships: new MembershipRepo(t.db) });
    handler = createMcpHttpHandler({
      runs: { searchInWorkspace: refuse, get: refuse },
      approvals: { list: refuse, get: refuse, vote: refuse },
      gates: { getPending: refuse, resume: refuse },
      flags: domain.flags,
      scope,
      projects: new ProjectScope({ workspaces: scope, projects: project.projects, products: project.products }),
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
      settings: { agentsMayDecide: refuse },
      confirmations: undefined,
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('declares every flag tool read-only', async () => {
    const listed = await rpc(ada, 'tools/list', {});

    const flagTools = listed.result?.tools?.filter(tool => tool.name.startsWith('mocco_flags_')) ?? [];
    expect(flagTools.length).toBeGreaterThan(0);
    expect(flagTools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("finds the flags of the caller's only project without being told which", async () => {
    const flags = flagsOf(await call('mocco_flags_search', {}));

    expect(flags.map(flag => flag.key)).toEqual(['dark-mode', 'new-checkout', 'pricing-v2']);
  });

  it('keeps concise concise, and says more only when asked', async () => {
    const [concise] = flagsOf(await call('mocco_flags_search', { query: 'checkout' }));
    const [detailed] = flagsOf(await call('mocco_flags_search', { query: 'checkout', responseFormat: 'detailed' }));

    expect(concise).not.toHaveProperty('variants');
    expect(concise?.environments).toEqual([
      { environment: 'staging', enabled: false },
      { environment: 'production', enabled: false },
    ]);
    expect(detailed).toMatchObject({ description: 'The one-page checkout', variants: { on: true, off: false } });
    expect(detailed?.environments[0]).toHaveProperty('serving', "disabled: callers get their code's default");
  });

  it('filters by text in the key or description, lifecycle, and who manages the flag', async () => {
    const byDescription = flagsOf(await call('mocco_flags_search', { query: 'ONE-PAGE' }));
    const permanent = flagsOf(await call('mocco_flags_search', { lifecycle: 'permanent' }));
    const fromTheConsole = flagsOf(await call('mocco_flags_search', { repoManaged: false }));

    expect(byDescription.map(flag => flag.key)).toEqual(['new-checkout']);
    expect(permanent.map(flag => flag.key)).toEqual(['pricing-v2']);
    expect(fromTheConsole.map(flag => flag.key)).toEqual(['dark-mode', 'new-checkout']);
  });

  it('pages by key, and says where the next page starts only when there is one', async () => {
    const first = bodyOf(await call('mocco_flags_search', { limit: 2 }));
    const second = bodyOf(await call('mocco_flags_search', { limit: 2, after: first.nextAfter }));

    expect((first.flags as FlagRow[]).map(flag => flag.key)).toEqual(['dark-mode', 'new-checkout']);
    expect(first.nextAfter).toBe('new-checkout');
    expect((second.flags as FlagRow[]).map(flag => flag.key)).toEqual(['pricing-v2']);
    expect(second).not.toHaveProperty('nextAfter');
  });

  it('reads one flag with what it serves in each environment', async () => {
    const currentVersion = await versionOfProduction();
    await domain.flags.applyChangeset(mine, myProject, ada, {
      environmentId: production,
      baseVersion: currentVersion,
      ops: [{ op: 'set_enabled', flagKey: 'new-checkout', enabled: true }],
      reason: null,
    });

    const flag = bodyOf(await call('mocco_flags_get', { flagKey: 'new-checkout', responseFormat: 'detailed' }));

    expect(flag).toMatchObject({ key: 'new-checkout', repoManaged: false, variants: { on: true, off: false } });
    expect(flag.environments).toEqual([
      expect.objectContaining({ environment: 'staging', enabled: false, isProtected: false }),
      expect.objectContaining({ environment: 'production', enabled: true, serving: 'serves on', rules: [] }),
    ]);
  });

  it('says where a repo-managed flag is changed', async () => {
    const flag = bodyOf(await call('mocco_flags_get', { flagKey: 'pricing-v2' }));

    expect(flag).toMatchObject({ repoManaged: true, managedIn: '.mocco/flags.yml' });
    // Concise names the variants; their values are in the detailed shape.
    expect(flag.variants).toEqual(expect.arrayContaining(['old', 'new']));
  });

  it('says a flag the project does not have was not found', async () => {
    const answer = await call('mocco_flags_get', { flagKey: 'their-secret-flag' });

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('Flag "their-secret-flag" was not found');
  });

  it('refuses a workspace the caller is not in exactly as one that does not exist', async () => {
    const nowhere = randomUUID();

    const existing = await call('mocco_flags_search', { workspaceId: theirs, projectId: theirProject });
    const missing = await call('mocco_flags_search', { workspaceId: nowhere, projectId: randomUUID() });

    expect(existing.result?.isError).toBe(true);
    expect(textOf(existing)).toContain('No workspace');
    expect(textOf(existing).replace(theirs, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
    expect(textOf(existing)).not.toContain('their-secret-flag');
  });

  it("refuses another workspace's project exactly as one that does not exist", async () => {
    const nowhere = randomUUID();

    const foreign = await call('mocco_flags_get', { projectId: theirProject, flagKey: 'their-secret-flag' });
    const missing = await call('mocco_flags_get', { projectId: nowhere, flagKey: 'their-secret-flag' });

    expect(foreign.result?.isError).toBe(true);
    expect(textOf(foreign)).toContain('was not found');
    expect(textOf(foreign).replace(theirProject, '<id>')).toBe(textOf(missing).replace(nowhere, '<id>'));
  });

  it('refuses where the flags product is off, as the console does', async () => {
    await project.products.disable(mine, Products.flags);

    const answer = await call('mocco_flags_search', {});

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain('not enabled');
  });

  it('names the projects to choose from when there is more than one', async () => {
    const second = await project.projects.create(mine, { name: 'Admin', handle: 'admin' });

    const answer = await call('mocco_flags_search', {});

    expect(answer.result?.isError).toBe(true);
    expect(textOf(answer)).toContain(`Admin (${second.id})`);
    expect(textOf(answer)).toContain(`Shop (${myProject})`);
  });

  describe('mocco_flags_changesets_search', () => {
    beforeEach(async () => {
      await domain.flagGovernance.setChangeGate(mine, myProject, ada, {
        environmentId: production,
        gate: { resume: [{ role: 'release', count: 1 }], prevent_self: true, reason_required: false },
      });
      const currentVersion = await versionOfProduction();
      await domain.flags.applyChangeset(mine, myProject, ada, {
        environmentId: production,
        baseVersion: currentVersion,
        ops: [{ op: 'set_enabled', flagKey: 'dark-mode', enabled: true }],
        reason: 'launch',
      });
    });

    it('finds what waits for approval, and names the request deciding it', async () => {
      const { changesets } = bodyOf(await call('mocco_flags_changesets_search', {})) as {
        changesets: Record<string, unknown>[];
      };

      expect(changesets).toEqual([
        expect.objectContaining({
          environment: 'production',
          state: 'pending',
          changes: ['flag dark-mode: enabled'],
          reason: 'launch',
          approvalRequestId: expect.any(String),
        }),
      ]);
      expect(changesets[0]).not.toHaveProperty('diff');
    });

    it('adds the diff when asked, and narrows to one environment by key', async () => {
      const detailed = bodyOf(
        await call('mocco_flags_changesets_search', { environment: 'production', responseFormat: 'detailed' }),
      ) as { changesets: Record<string, unknown>[] };
      const staging = bodyOf(await call('mocco_flags_changesets_search', { environment: 'staging' }));

      expect(detailed.changesets[0]).toMatchObject({
        diff: [{ subject: 'flag', key: 'dark-mode', field: 'enabled', before: false, after: true }],
      });
      expect(staging.changesets).toEqual([]);
    });

    it('pages newest first without losing changesets written in the same transaction', async () => {
      // Each new flag is added to both environments in one transaction: same `createdAt`.
      const all = bodyOf(await call('mocco_flags_changesets_search', { state: 'applied' })) as {
        changesets: { id: string }[];
      };
      const paged: string[] = [];
      let before: unknown;
      for (let page = 0; page < all.changesets.length + 1; page += 1) {
        // eslint-disable-next-line no-await-in-loop -- each page needs the previous cursor
        const answer = bodyOf(await call('mocco_flags_changesets_search', { state: 'applied', limit: 1, before }));
        paged.push(...(answer.changesets as { id: string }[]).map(each => each.id));
        ({ nextBefore: before } = answer);
        if (before === undefined) {
          break;
        }
      }

      expect(all.changesets.length).toBeGreaterThan(2);
      expect(paged).toEqual(all.changesets.map(each => each.id));
    });

    it('says an environment the project does not have was not found', async () => {
      const answer = await call('mocco_flags_changesets_search', { environment: 'moon' });

      expect(answer.result?.isError).toBe(true);
      expect(textOf(answer)).toContain('moon was not found');
    });
  });
});
