import { randomUUID } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import { RunStates, RunStepStatuses, TriggerSources } from '@mocco/common/execution';
import { GateStates } from '@mocco/common/governance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '@backend/domain/audit/AuditService';
import { AuditRepo } from '@backend/domain/audit/repos/audit.repo';
import { BrokerDenials, CredentialBroker } from '@backend/domain/credential/CredentialBroker';
import { StubCredentialProvider } from '@backend/domain/credential/providers/stub';
import { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import { hashToken } from '@backend/domain/execution/callback-token';
import { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import { RunRepo } from '@backend/domain/execution/repos/run.repo';
import { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import { expectOne } from '@backend/infra/db/rows';
import {
  commitConfigs,
  commits,
  providerConnections,
  repos,
  runGates,
  runs,
  runSteps,
  users,
  workspaces,
} from '@backend/infra/db/schema';
import { createTestDb, type TestDb } from '@backend/infra/db/testing/pglite';

import type { CredentialIssueRequest, CredentialProvider, IssuedCredentials } from '@backend/domain/credential/ports';
import type { GateRequirements } from '@mocco/common/governance';
import type { Credential, MoccoConfig } from '@mocco/common/mocco-config';

/** The plaintext per-run token; only its sha-256 is stored (hashToken — the shared SSOT). */
const TOKEN = 'a'.repeat(64);

/** The credentialed step's request in the pinned config — the authoritative
 * provider/role/ttl the broker judges (never taken from the request body). */
const CREDENTIAL: Credential = { provider: 'aws', role: 'deployer', ttl: 900, gate: 'approve' };

/** The step index of the credentialed step in the config below (item 0 is the gate). */
const STEP_INDEX = 1;

const GATE_REQUIREMENTS: GateRequirements = {
  resume: [{ role: 'lead', count: 1 }],
  prevent_self: false,
  reason_required: false,
};

/** v2: a dominating gate then a credentialed deploy step (the shape the lint requires). */
function configWith(credential: Credential | undefined): MoccoConfig {
  return {
    version: 2,
    pipeline: 'deploy',
    steps: [
      { kind: 'gate', name: 'approve', resume: [{ role: 'lead', count: 1 }] },
      { kind: 'step', run: 'deploy', executor: 'generic', ...(credential && { credential }) },
    ],
  };
}

/** A `CredentialProvider` that records its calls and delegates to the injected
 * `StubCredentialProvider` — lets the ALLOW test assert the exact issue request. */
class RecordingProvider implements CredentialProvider {
  private readonly inner = new StubCredentialProvider();

  readonly calls: CredentialIssueRequest[] = [];

  async issue(request: CredentialIssueRequest): Promise<IssuedCredentials> {
    this.calls.push(request);
    return await this.inner.issue(request);
  }
}

interface SeedOptions {
  stepStatus?: (typeof RunStepStatuses)[keyof typeof RunStepStatuses];
  gateState?: (typeof GateStates)[keyof typeof GateStates];
  /** Drop the step's `credential` (the step then requests nothing). */
  stripCredential?: boolean;
  includeGrant?: boolean;
  grantMaxTtl?: number;
  /** Insert the grant under a DIFFERENT workspace (tenant-isolation probe). */
  grantWorkspaceId?: string;
}

describe('CredentialBroker (pglite, fail-closed)', () => {
  let t: TestDb;
  let provider: RecordingProvider;
  let broker: CredentialBroker;
  let audit: AuditService;

  beforeEach(async () => {
    t = await createTestDb();
    provider = new RecordingProvider();
    audit = new AuditService({ audit: new AuditRepo(t.db) });
    broker = new CredentialBroker({
      runs: new RunRepo(t.db),
      steps: new RunStepRepo(t.db),
      runGates: new RunGateRepo(t.db),
      configs: new CommitConfigRepo(t.db),
      commits: new CommitRepo(t.db),
      grants: new CredentialGrantRepo(t.db),
      provider,
      audit,
    });
  });
  afterEach(async () => {
    await t.close();
  });

  /** Seed a full run pinned to a v2 config with a gate + credentialed step, plus a
   * matching grant, and return the run id. Options bend one dimension per DENY test. */
  async function seed(options: SeedOptions = {}): Promise<{ runId: string; workspaceId: string; repoId: string }> {
    const {
      stepStatus = RunStepStatuses.dispatched,
      gateState = GateStates.resumed,
      stripCredential = false,
      includeGrant = true,
      grantMaxTtl = 3600,
      grantWorkspaceId,
    } = options;
    const credential = stripCredential ? undefined : CREDENTIAL;

    const workspaceId = expectOne(
      await t.db.insert(workspaces).values({ name: 'W', slug: randomUUID() }).returning(),
    ).id;
    const userId = expectOne(
      await t.db
        .insert(users)
        .values({ email: `${randomUUID()}@example.com` })
        .returning(),
    ).id;
    const conn = expectOne(
      await t.db
        .insert(providerConnections)
        .values({ workspaceId, provider: 'github', externalAccountId: randomUUID(), accountLogin: 'acme' })
        .returning(),
    );
    const repoId = expectOne(
      await t.db
        .insert(repos)
        .values({
          workspaceId,
          connectionId: conn.id,
          externalRepoId: randomUUID(),
          owner: 'fi-workers',
          name: 'api',
          defaultBranch: 'main',
        })
        .returning(),
    ).id;
    const commit = expectOne(
      await t.db
        .insert(commits)
        .values({
          repoId,
          sha: `sha-${randomUUID()}`,
          branch: 'main',
          message: 'msg',
          authorName: 'A',
          authorEmail: 'a@example.com',
          committedAt: new Date('2026-01-01T00:00:00Z'),
        })
        .returning(),
    );
    const config = configWith(credential);
    const configRow = expectOne(
      await t.db
        .insert(commitConfigs)
        .values({
          commitId: commit.id,
          present: true,
          rawYaml: 'version: 2',
          parsedJson: config,
          valid: true,
          validationErrors: [],
        })
        .returning(),
    );
    const run = expectOne(
      await t.db
        .insert(runs)
        .values({
          workspaceId,
          commitId: commit.id,
          commitConfigId: configRow.id,
          state: RunStates.running,
          currentIndex: STEP_INDEX,
          callbackTokenHash: hashToken(TOKEN),
          triggeredByUserId: userId,
          triggerSource: TriggerSources.manual,
        })
        .returning(),
    );
    await t.db.insert(runSteps).values({
      workspaceId,
      runId: run.id,
      stepIndex: STEP_INDEX,
      name: 'deploy',
      executor: 'generic',
      status: stepStatus,
    });
    await t.db.insert(runGates).values({
      workspaceId,
      runId: run.id,
      itemIndex: 0,
      name: 'approve',
      state: gateState,
      requirements: GATE_REQUIREMENTS,
    });
    if (includeGrant) {
      await new CredentialGrantRepo(t.db).create({
        workspaceId: grantWorkspaceId ?? workspaceId,
        repoId,
        pipeline: 'deploy',
        gateName: 'approve',
        provider: 'aws',
        role: 'deployer',
        maxTtlSeconds: grantMaxTtl,
      });
    }
    return { runId: run.id, workspaceId, repoId };
  }

  it('ALLOWS when every check passes: issues with the config triple and returns credentials', async () => {
    const { runId } = await seed();

    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credentials.provider).toBe('aws');
      expect(result.credentials.role).toBe('deployer');
      expect(result.credentials.value).toBe('stub-credential');
    }
    // Issued with the PINNED config's {provider, role, ttl} — never a request-body value.
    expect(provider.calls).toEqual([{ provider: 'aws', role: 'deployer', ttlSeconds: 900 }]);
  });

  it('DENIES an unknown run (never issues)', async () => {
    await seed();
    const result = await broker.issue({ runId: randomUUID(), stepIndex: STEP_INDEX, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES a bad token', async () => {
    const { runId } = await seed();
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: 'wrong-token' });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES an absent (empty) token', async () => {
    const { runId } = await seed();
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: '' });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES a step that is still pending (never dispatched)', async () => {
    const { runId } = await seed({ stepStatus: RunStepStatuses.pending });
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES when the required gate is not resumed (pending)', async () => {
    const { runId } = await seed({ gateState: GateStates.pending });
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES when the required gate was rejected', async () => {
    const { runId } = await seed({ gateState: GateStates.rejected });
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES when no allowlist grant matches', async () => {
    const { runId } = await seed({ includeGrant: false });
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES when the requested ttl (from config) exceeds the grant ceiling', async () => {
    // Config requests ttl 900; the grant caps at 300.
    const { runId } = await seed({ grantMaxTtl: 300 });
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES when the step requests no credentials', async () => {
    const { runId } = await seed({ stripCredential: true });
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  it('DENIES when the only grant belongs to another workspace (tenant isolation)', async () => {
    const other = expectOne(await t.db.insert(workspaces).values({ name: 'Other', slug: randomUUID() }).returning()).id;
    const { runId } = await seed({ grantWorkspaceId: other });
    const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
    expect(result.ok).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });

  describe('audit write-path (slice 8)', () => {
    it('an ALLOW appends credential.issued with the config triple (never the secret value) and the chain verifies', async () => {
      const { runId, workspaceId } = await seed();

      const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
      expect(result.ok).toBe(true);

      const entries = await new AuditRepo(t.db).all(workspaceId);
      const issued = entries.find(entry => entry.action === AuditActions.credentialIssued);
      expect(issued).toBeDefined();
      expect(issued?.actorUserId).toBeNull(); // a machine/runtime request
      expect(issued?.subjectType).toBe('run');
      expect(issued?.subjectId).toBe(runId);
      expect(issued?.payload).toMatchObject({ provider: 'aws', role: 'deployer', ttl: 900, gate: 'approve' });
      // The minted secret is NEVER recorded.
      expect(JSON.stringify(issued?.payload)).not.toContain('stub-credential');
      expect(issued?.payload).not.toHaveProperty('value');
      expect(await audit.verify(workspaceId)).toEqual({ intact: true });
    });

    it('a DENY appends credential.denied with the reason and the chain verifies', async () => {
      const { runId, workspaceId } = await seed({ gateState: GateStates.pending });

      const result = await broker.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
      expect(result.ok).toBe(false);

      const entries = await new AuditRepo(t.db).all(workspaceId);
      const denied = entries.find(entry => entry.action === AuditActions.credentialDenied);
      expect(denied).toBeDefined();
      expect(denied?.actorUserId).toBeNull();
      expect(denied?.subjectId).toBe(runId);
      expect(denied?.payload).toMatchObject({ reason: BrokerDenials.gateNotResumed, stepIndex: STEP_INDEX });
      expect(await audit.verify(workspaceId)).toEqual({ intact: true });
    });

    it('is fail-open — an ALLOW still issues when audit.record throws', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const boom = new Error('audit db down');
      const throwingAudit = new AuditService({
        audit: { appendChained: vi.fn().mockRejectedValue(boom) } as never,
      });
      const failing = new CredentialBroker({
        runs: new RunRepo(t.db),
        steps: new RunStepRepo(t.db),
        runGates: new RunGateRepo(t.db),
        configs: new CommitConfigRepo(t.db),
        commits: new CommitRepo(t.db),
        grants: new CredentialGrantRepo(t.db),
        provider,
        audit: throwingAudit,
      });
      const { runId } = await seed();

      const result = await failing.issue({ runId, stepIndex: STEP_INDEX, token: TOKEN });
      // The verdict is unchanged despite the audit append failing.
      expect(result.ok).toBe(true);
      spy.mockRestore();
    });
  });
});
