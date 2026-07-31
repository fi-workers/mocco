import { RunStepStatuses } from '@mocco/common/execution';
import { GateStates } from '@mocco/common/governance';
import { moccoConfigSchema, PipelineItemKinds } from '@mocco/common/mocco-config';

import { evaluateGrant } from '@backend/domain/credential/evaluate-grant';
import { isTokenValid } from '@backend/domain/execution/callback-token';

import type { GrantDenial } from '@backend/domain/credential/evaluate-grant';
import type { CredentialProvider, IssuedCredentials } from '@backend/domain/credential/ports';
import type { CredentialGrantRepo } from '@backend/domain/credential/repos/credential-grant.repo';
import type { RunStepRepo } from '@backend/domain/execution/repos/run-step.repo';
import type { RunRepo } from '@backend/domain/execution/repos/run.repo';
import type { RunGateRepo } from '@backend/domain/governance/repos/run-gate.repo';
import type { CommitConfigRepo } from '@backend/domain/integration/repos/commit-config.repo';
import type { CommitRepo } from '@backend/domain/integration/repos/commit.repo';
import type { CredentialRequest } from '@mocco/common/credential';
import type { RunStepStatus } from '@mocco/common/execution';
import type { Credential, MoccoConfig } from '@mocco/common/mocco-config';

/** Broker-specific DENY reasons (the allowlist reasons live in `GrantDenials`). SSOT
 * for the fail-closed decision's own branches (no magic strings). Every reason is
 * LOGGED, never returned to the caller — the ext route replies with a fixed generic
 * 403 so which check failed is never leaked. */
export const BrokerDenials = {
  runNotFound: 'run not found',
  badToken: 'invalid or absent per-run token',
  stepNotDispatched: 'step was not dispatched by mocco',
  noCredentialOnStep: 'step requests no credentials',
  gateNotResumed: 'required gate is not resumed',
} as const;
export type BrokerDenial = (typeof BrokerDenials)[keyof typeof BrokerDenials];

/** Why the broker denied — a broker branch or an allowlist-evaluator branch. */
export type CredentialDenyReason = BrokerDenial | GrantDenial;

/** The broker's verdict: ALLOW carries the minted credentials; DENY carries a
 * (loggable) reason the caller never sees. */
export type CredentialDecision =
  { ok: true; credentials: IssuedCredentials } | { ok: false; reason: CredentialDenyReason };

/** Step statuses that mean mocco actually advanced the run to this step (not a
 * bypass): only `dispatched` or `running` may receive credentials. */
const ISSUABLE_STEP_STATUSES = new Set<RunStepStatus>([RunStepStatuses.dispatched, RunStepStatuses.running]);

/** Log a DENY reason (never leaked to the caller) and return the typed verdict. The
 * ext route maps every DENY to a fixed generic 403. */
function deny(reason: CredentialDenyReason): { ok: false; reason: CredentialDenyReason } {
  console.warn(`[broker] denied: ${reason}`);
  return { ok: false, reason };
}

/** Read the step's `credential` request from the pinned config at the given item
 * index. Only a v2 step item can carry one; a gate, a v1 step, an out-of-range
 * index, or a step without `credential` yields undefined (→ DENY).
 *
 * sonarjs/function-return-type is a false positive: the return type is
 * `Credential | undefined`; each branch returns a legitimate member of it. */
// eslint-disable-next-line sonarjs/function-return-type
function credentialForStep(config: MoccoConfig, stepIndex: number): Credential | undefined {
  if (config.version !== 2) {
    return undefined;
  }
  const item = config.steps[stepIndex];
  if (item === undefined || item.kind !== PipelineItemKinds.step) {
    return undefined;
  }
  return item.credential;
}

export interface CredentialBrokerDeps {
  runs: RunRepo;
  steps: RunStepRepo;
  runGates: RunGateRepo;
  configs: CommitConfigRepo;
  commits: CommitRepo;
  grants: CredentialGrantRepo;
  provider: CredentialProvider;
}

/**
 * The credential broker (slice 7, PR2) — the un-bypassable enforcement that makes
 * "write ≠ deploy" hold. A step's workflow asks for cloud credentials at runtime;
 * the broker issues them ONLY if the run reached that step through its required
 * resumed gate AND the request is within the workspace allowlist. Fail-closed: every
 * check that doesn't pass returns a typed DENY (logged, never leaked). Anemic (ADR
 * 0012) — reaches the DB only through injected repos.
 *
 * The `credential` (provider/role/ttl/gate) is read from the run's IMMUTABLE pinned
 * config snapshot, NEVER the request body — the request carries only `{runId,
 * stepIndex, token}`, so a compromised runner can't tamper the authoritative fields.
 */
export class CredentialBroker {
  constructor(private readonly deps: CredentialBrokerDeps) {}

  /**
   * The §3 fail-closed decision, IN ORDER — each failure returns a DENY, only the
   * all-pass path issues credentials:
   *   a. resolve the run + verify the per-run token (constant-time)
   *   b. the step is `dispatched`|`running` (mocco actually advanced here)
   *   c. read the step's `credential` from the PINNED config (not the request body)
   *   d. the named gate's `run_gate` state is `resumed`
   *   e. the (repo, pipeline, gate, provider, role) request matches an allowlist grant
   *      and the requested ttl is within its ceiling
   *   f. issue through the provider port
   */
  async issue(request: CredentialRequest): Promise<CredentialDecision> {
    // (a) run + token — a manual dispatch has no token, so it dies here.
    const run = await this.deps.runs.findById(request.runId);
    if (run === undefined) {
      return deny(BrokerDenials.runNotFound);
    }
    if (!isTokenValid(request.token, run.callbackTokenHash)) {
      return deny(BrokerDenials.badToken);
    }

    // (b) the step must have been advanced to by mocco (dispatched|running).
    const step = await this.deps.steps.findByRunAndIndex(request.runId, request.stepIndex);
    if (step === undefined || !ISSUABLE_STEP_STATUSES.has(step.status)) {
      return deny(BrokerDenials.stepNotDispatched);
    }

    // (c) read the credential request from the PINNED config snapshot — never the body.
    const snapshot = await this.deps.configs.findById(run.commitConfigId);
    if (snapshot === undefined) {
      return deny(BrokerDenials.noCredentialOnStep);
    }
    const config = moccoConfigSchema.parse(snapshot.parsedJson);
    const credential = credentialForStep(config, request.stepIndex);
    if (credential === undefined) {
      return deny(BrokerDenials.noCredentialOnStep);
    }

    // (d) the named gate must be resumed.
    const gates = await this.deps.runGates.findByRun(run.workspaceId, request.runId);
    const gate = gates.find(candidate => candidate.name === credential.gate);
    if (gate === undefined || gate.state !== GateStates.resumed) {
      return deny(BrokerDenials.gateNotResumed);
    }

    // (e) the allowlist is the authority — resolve repoId (run → commit → repo) +
    // pipeline (from the parsed config), match a grant, and check ttl ≤ its ceiling.
    const commit = await this.deps.commits.getByIdInWorkspace(run.workspaceId, run.commitId);
    const grant = await this.deps.grants.findMatching(run.workspaceId, {
      repoId: commit.repoId,
      pipeline: config.pipeline,
      gateName: credential.gate,
      provider: credential.provider,
      role: credential.role,
    });
    const decision = evaluateGrant(
      { provider: credential.provider, role: credential.role, ttl: credential.ttl },
      grant,
    );
    if (!decision.allowed) {
      return deny(decision.reason);
    }

    // (f) every check passed — issue through the provider port.
    const credentials = await this.deps.provider.issue({
      provider: credential.provider,
      role: credential.role,
      ttlSeconds: credential.ttl,
    });
    return { ok: true, credentials };
  }
}
