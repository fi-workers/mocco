import { randomUUID } from 'node:crypto';

import { ExecutorIds } from '@mocco/common/execution';
import { RulePresets } from '@mocco/common/notification';
import { WorkspaceMemberRoles } from '@mocco/common/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { AuthService } from '@backend/domain/auth/AuthService';
import { createProvider } from '@backend/domain/auth/provider';
import { WorkspaceService } from '@backend/domain/auth/WorkspaceService';
import { GrantService } from '@backend/domain/credential/GrantService';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
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
import { RoleService } from '@backend/domain/governance/RoleService';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import {
  botInGuild,
  createTestChannelService,
  guildChannelsReply,
  messageCreated,
  seedGuild,
} from '@backend/domain/notification/testing/channel-service';
import { createProjectDomain } from '@backend/domain/project/instance';
import { members } from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';
import { appRouter } from '@backend/transport/trpc/root';
import { notificationRouter } from '@backend/transport/trpc/routers/notification';

import type { FakeReply } from '@backend/domain/notification/testing/fake-discord-fetch';

const ALERTS = { id: '700000000000000001', name: 'alerts' };

const signUpViaHttp = async (auth: AuthService, email: string) => {
  const response = await auth.handler(
    new Request('https://local.test/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'fixture-password-1', name: 'fixture-user' }),
    }),
  );
  return new Headers({ cookie: response.headers.get('set-cookie') ?? '' });
};

const codeOf = async (call: () => Promise<unknown>) => {
  try {
    await call();
    return 'OK';
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
};

const codesOf = async (calls: Record<string, () => Promise<unknown>>) => {
  const entries = await Object.entries(calls).reduce<Promise<[string, string][]>>(async (previous, [name, call]) => {
    const done = await previous;
    return [...done, [name, await codeOf(call)]];
  }, Promise.resolve([]));
  return Object.fromEntries(entries);
};

describe('notification router on pglite', () => {
  let t: TestDb;
  let auth: AuthService;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    t = await createTestDb();
    const provider = createProvider(t.db, { secret: 'test-secret-not-for-prod' });
    auth = new AuthService(provider);
    workspace = new WorkspaceService(provider);
  });
  afterEach(async () => {
    await t.close();
  });

  const makeAudit = (): AuditService => new AuditService({ audit: new AuditRepo(t.db) });

  /** A caller whose notification service answers Discord calls with `script`. */
  const signedInCaller = async (email: string, ...script: FakeReply[]) => {
    const headers = await signUpViaHttp(auth, email);
    const session = await auth.getSession(headers);
    const runs = new RunService({
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
      audit: makeAudit(),
      waitUntil: () => {
        /* notification router tests don't exercise the run loop */
      },
    });
    const gates = new GateService({
      bus: createTestEventBus(t.db),
      runs: new RunRepo(t.db),
      runGates: new RunGateRepo(t.db),
      resumes: new ResumeRepo(t.db),
      memberships: new RoleMembershipRepo(t.db),
      events: new RunEventRepo(t.db),
      resumeRun: async (run, gateItemIndex) => await runs.resumeFromGate(run, gateItemIndex),
      audit: makeAudit(),
    });
    const { service, requests } = createTestChannelService(t.db, ...script);
    const ctx = {
      ...createProjectDomain(t.db),
      auth,
      workspace,
      runs,
      roles: new RoleService({ roles: new RoleRepo(t.db), memberships: new RoleMembershipRepo(t.db) }),
      gates,
      grants: new GrantService({ grants: new CredentialGrantRepo(t.db) }),
      audit: makeAudit(),
      notifications: service,
      session,
      headers,
    };
    return { api: appRouter.createCaller(ctx), userId: session?.user.id ?? '', requests };
  };

  type Api = Awaited<ReturnType<typeof signedInCaller>>['api'];

  /** An owner's workspace with an installed guild and one channel. */
  const ownerWithChannel = async (email: string) => {
    const owner = await signedInCaller(email, ...botInGuild(), guildChannelsReply(ALERTS), messageCreated());
    const { workspace: ws } = await owner.api.workspace.create({ name: 'W' });
    const guild = await seedGuild(t.db, ws.id, '800000000000000001', owner.userId);
    const { channel, test } = await owner.api.notification.createChannel({
      workspaceId: ws.id,
      guildId: guild.id,
      channelId: ALERTS.id,
    });
    const { rules } = await owner.api.notification.applyDefaultRules({
      workspaceId: ws.id,
      channelId: channel.id,
      preset: RulePresets.mocco,
    });
    const ruleId = rules[0]?.id ?? '';
    return { owner, workspaceId: ws.id, guild, channel, test, ruleId };
  };

  /** Every procedure, with ids taken from `scope` — used for the cross-tenant and role sweeps. */
  const everyProcedure = (
    api: Api,
    scope: { workspaceId: string; guildId: string; channelId: string; ruleId: string },
  ): Record<string, () => Promise<unknown>> => {
    const { workspaceId, guildId, channelId, ruleId } = scope;
    return {
      guilds: async () => await api.notification.guilds({ workspaceId }),
      guildChannels: async () => await api.notification.guildChannels({ workspaceId, guildId }),
      channels: async () => await api.notification.channels({ workspaceId }),
      createChannel: async () => await api.notification.createChannel({ workspaceId, guildId, channelId: ALERTS.id }),
      deleteChannel: async () => await api.notification.deleteChannel({ workspaceId, channelId }),
      reenableChannel: async () => await api.notification.reenableChannel({ workspaceId, channelId }),
      rules: async () => await api.notification.rules({ workspaceId, channelId }),
      addRule: async () => await api.notification.addRule({ workspaceId, channelId, eventType: 'run.succeeded' }),
      removeRule: async () => await api.notification.removeRule({ workspaceId, ruleId }),
      applyDefaultRules: async () =>
        await api.notification.applyDefaultRules({ workspaceId, channelId, preset: RulePresets.github }),
      deliveries: async () => await api.notification.deliveries({ workspaceId }),
    };
  };

  it('creates a channel with its test result and lists channels without secrets or vendor ids', async () => {
    const { owner, workspaceId, channel, test } = await ownerWithChannel('owner@example.com');

    expect(test).toEqual({ sent: true, reason: null, channelDisabled: false });
    const { channels } = await owner.api.notification.channels({ workspaceId });
    expect(channels).toHaveLength(1);
    expect(channels[0]).toEqual({
      id: channel.id,
      kind: 'discord',
      name: '#alerts',
      config: { guildId: '800000000000000001', channelId: ALERTS.id, channelName: 'alerts' },
      status: 'active',
      disabledReason: null,
      createdAt: expect.any(Date) as Date,
      updatedAt: expect.any(Date) as Date,
    });
    expect(channels[0]).not.toHaveProperty('secretSealed');
    expect(channels[0]).not.toHaveProperty('externalId');
    const { guilds } = await owner.api.notification.guilds({ workspaceId });
    expect(guilds[0]).not.toHaveProperty('installedByUserId');
    expect(guilds[0]).not.toHaveProperty('workspaceId');
  });

  it('a non-member gets NOT_FOUND on every procedure', async () => {
    const { workspaceId, guild, channel, ruleId } = await ownerWithChannel('owner@example.com');
    const stranger = await signedInCaller('stranger@example.com');

    const codes = await codesOf(
      everyProcedure(stranger.api, { workspaceId, guildId: guild.id, channelId: channel.id, ruleId }),
    );

    expect(Object.values(codes).every(code => code === 'NOT_FOUND')).toBe(true);
    // The sweep covers every procedure of the router.
    expect(Object.keys(codes)).toHaveLength(Object.keys(notificationRouter._def.procedures).length);
    expect(stranger.requests).toHaveLength(0);
  });

  it("the owner of workspace B gets NOT_FOUND for A's guild, channel and rule ids", async () => {
    const a = await ownerWithChannel('a@example.com');
    const b = await signedInCaller('b@example.com');
    const { workspace: wsB } = await b.api.workspace.create({ name: 'B' });

    const codes = await codesOf(
      everyProcedure(b.api, { workspaceId: wsB.id, guildId: a.guild.id, channelId: a.channel.id, ruleId: a.ruleId }),
    );

    // Workspace-only reads succeed (and see nothing of A); every id of A is NOT_FOUND.
    expect(codes).toEqual({
      guilds: 'OK',
      guildChannels: 'NOT_FOUND',
      channels: 'OK',
      createChannel: 'NOT_FOUND',
      deleteChannel: 'NOT_FOUND',
      reenableChannel: 'NOT_FOUND',
      rules: 'NOT_FOUND',
      addRule: 'NOT_FOUND',
      removeRule: 'NOT_FOUND',
      applyDefaultRules: 'NOT_FOUND',
      deliveries: 'OK',
    });
    expect(await b.api.notification.channels({ workspaceId: wsB.id })).toEqual({ channels: [] });
    expect(await a.owner.api.notification.rules({ workspaceId: a.workspaceId, channelId: a.channel.id })).toMatchObject(
      {
        rules: expect.arrayContaining([expect.objectContaining({ id: a.ruleId })]) as unknown,
      },
    );
    expect(b.requests).toHaveLength(0);
  });

  it('a plain member can read but gets FORBIDDEN on every write', async () => {
    const { workspaceId, guild, channel, ruleId } = await ownerWithChannel('owner@example.com');
    const member = await signedInCaller('member@example.com');
    await t.db
      .insert(members)
      .values({ organizationId: workspaceId, userId: member.userId, role: WorkspaceMemberRoles.member });

    const codes = await codesOf(
      everyProcedure(member.api, { workspaceId, guildId: guild.id, channelId: channel.id, ruleId }),
    );

    expect(codes).toEqual({
      guilds: 'OK',
      guildChannels: 'FORBIDDEN',
      channels: 'OK',
      createChannel: 'FORBIDDEN',
      deleteChannel: 'FORBIDDEN',
      reenableChannel: 'FORBIDDEN',
      rules: 'OK',
      addRule: 'FORBIDDEN',
      removeRule: 'FORBIDDEN',
      applyDefaultRules: 'FORBIDDEN',
      deliveries: 'OK',
    });
  });

  it('an admin can write, including with a comma-joined role set', async () => {
    const { workspaceId, channel } = await ownerWithChannel('owner@example.com');
    const admin = await signedInCaller('admin@example.com');
    await t.db.insert(members).values({ organizationId: workspaceId, userId: admin.userId, role: 'member,admin' });

    const { rule } = await admin.api.notification.addRule({
      workspaceId,
      channelId: channel.id,
      eventType: 'github.*',
      filter: { repo: 'fi-workers/api' },
    });
    expect(rule).toMatchObject({ eventType: 'github.*', filter: { repo: 'fi-workers/api' }, sourceId: null });
    await admin.api.notification.removeRule({ workspaceId, ruleId: rule.id });
  });

  it('maps domain errors: duplicate channel CONFLICT, unknown event type BAD_REQUEST, bad input BAD_REQUEST', async () => {
    const { owner, workspaceId, guild, channel } = await ownerWithChannel('owner@example.com');
    const again = await signedInCaller('owner2@example.com', ...botInGuild(), guildChannelsReply(ALERTS));
    await t.db
      .insert(members)
      .values({ organizationId: workspaceId, userId: again.userId, role: WorkspaceMemberRoles.owner });

    await expect(
      again.api.notification.createChannel({ workspaceId, guildId: guild.id, channelId: ALERTS.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      owner.api.notification.addRule({ workspaceId, channelId: channel.id, eventType: 'gate.nope' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      owner.api.notification.addRule({ workspaceId, channelId: channel.id, eventType: 'Not An Event' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(owner.api.notification.deliveries({ workspaceId, limit: 1000 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(owner.api.notification.removeRule({ workspaceId, ruleId: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
