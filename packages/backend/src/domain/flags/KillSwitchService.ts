import { AuditActions } from '@mocco/common/audit';
import { FlagEventTypes } from '@mocco/common/events';
import { ChangesetSources, FlagApprovalSubjects } from '@mocco/common/flags';
import { ApprovalKinds } from '@mocco/common/governance';
import { Severities } from '@mocco/common/notification';

import { publishBestEffort } from '@backend/domain/events/ports';
import { FlagEnvironmentNotFoundError, InvalidChangeError, KillNotAllowedError } from '@backend/domain/flags/errors';
import { FlagChangesetRepo } from '@backend/domain/flags/repos/flag-changeset.repo';
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { RulesetPublisher } from '@backend/domain/flags/RulesetPublisher';
import type { ApprovalService } from '@backend/domain/governance/ApprovalService';
import type { RoleMembershipRepo } from '@backend/domain/governance/repos/role-membership.repo';
import type { Db } from '@backend/infra/db/types';

export interface KillSwitchDeps {
  db: Db;
  audit: AuditService;
  approvals: ApprovalService;
  publisher: RulesetPublisher;
  memberships: RoleMembershipRepo;
  events?: EventPublisher;
  appOrigin?: string;
}

/**
 * The kill switch (#142, ADR 0024): one-way and instant. A kill makes the flag serve its
 * off variant in the environment — compiled as `ENABLED` with the off variant as default
 * and no targeting, so even a flagd client that ignores Mocco's metadata serves it. It
 * bypasses the environment's change gate (stopping a bad flag must never wait for an
 * approver), is always audited with its actor and reason, and on a protected environment
 * opens a post-hoc `review` under the gate. Restoring is a normal change: gated.
 */
export class KillSwitchService {
  constructor(private readonly deps: KillSwitchDeps) {}

  private async requireKillRole(workspaceId: string, killRoles: readonly string[], actorUserId: string) {
    if (killRoles.length === 0) {
      return;
    }
    const roles = await this.deps.memberships.listRolesForUser(workspaceId, actorUserId);
    if (roles.every(role => !killRoles.includes(role.name))) {
      throw new KillNotAllowedError(killRoles);
    }
  }

  private async alert(
    environment: { id: string; workspaceId: string; projectId: string; key: string; name: string },
    flagKey: string,
    reason: string,
    actorUserId: string,
    changesetId: string,
  ) {
    const { events } = this.deps;
    if (events === undefined) {
      return;
    }
    await publishBestEffort(events, FlagEventTypes.flagKilled, async () => {
      const by =
        (await new FlagChangesetRepo(this.deps.db).proposerLabel(environment.workspaceId, changesetId)) ?? 'someone';
      return {
        type: FlagEventTypes.flagKilled,
        workspaceId: environment.workspaceId,
        projectId: environment.projectId,
        subject: { type: 'flag_changeset', id: changesetId },
        dedupeKey: `${changesetId}:${actorUserId}`,
        payload: {
          facts: { environment: environment.key, flag: flagKey },
          message: {
            title: `Killed: ${flagKey} in ${environment.name}`.slice(0, 200),
            ...(this.deps.appOrigin !== undefined && {
              url: `${this.deps.appOrigin}/workspaces/${environment.workspaceId}/p/${environment.projectId}/flags/${encodeURIComponent(flagKey)}?env=${environment.id}`,
            }),
            severity: Severities.error,
            fields: [
              { name: 'Environment', value: environment.name, inline: true },
              { name: 'Killed by', value: by.slice(0, 200), inline: true },
              // eslint-disable-next-line sonarjs/null-dereference -- reason is a required, trimmed string
              { name: 'Reason', value: reason.slice(0, 500), inline: false },
            ],
            footer: 'Mocco feature flags',
          },
        },
      };
    });
  }

  /** Kill `flagKey` in an environment now. `reason` is required: it is what the review reads. */
  async kill(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { environmentId: string; flagKey: string; reason: string },
  ) {
    const environment = await new FlagEnvironmentRepo(this.deps.db).find(workspaceId, projectId, input.environmentId);
    if (environment === undefined) {
      throw new FlagEnvironmentNotFoundError(input.environmentId);
    }
    await this.requireKillRole(workspaceId, environment.killRoles, actorUserId);
    const reason = input.reason.trim();
    if (reason === '') {
      throw new InvalidChangeError('Say why the flag is killed');
    }
    // No base version: a kill applies to whatever is current, and never waits.
    const { changeset } = await this.deps.db.transaction(
      async tx =>
        await this.deps.publisher.apply(tx, workspaceId, {
          environmentId: environment.id,
          ops: [{ op: 'kill', flagKey: input.flagKey }],
          source: ChangesetSources.kill,
          actorUserId,
          reason,
        }),
    );
    const review =
      environment.changeGate === null
        ? null
        : await this.deps.approvals.request(workspaceId, {
            projectId: environment.projectId,
            kind: ApprovalKinds.review,
            subjectType: FlagApprovalSubjects.kill,
            subjectId: changeset.id,
            action: { changesetId: changeset.id, environmentId: environment.id, flagKey: input.flagKey, reason },
            requirements: environment.changeGate,
            requestedByUserId: actorUserId,
          });
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.flagKilled,
      subjectType: 'flag_environment',
      subjectId: environment.id,
      payload: {
        flagKey: input.flagKey,
        reason,
        changesetId: changeset.id,
        version: changeset.appliedVersion,
        reviewRequestId: review?.id ?? null,
      },
    });
    await this.alert(environment, input.flagKey, reason, actorUserId, changeset.id);
    return { changeset, reviewRequestId: review?.id ?? null };
  }

  /** Set who may kill flags in an environment (empty: any workspace member). Audited. */
  async setKillRoles(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { environmentId: string; roles: string[] },
  ) {
    const environments = new FlagEnvironmentRepo(this.deps.db);
    const environment = await environments.find(workspaceId, projectId, input.environmentId);
    if (environment === undefined) {
      throw new FlagEnvironmentNotFoundError(input.environmentId);
    }
    const roles = [...new Set(input.roles)];
    await environments.setKillRoles(workspaceId, environment.id, roles);
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.flagKillRolesChanged,
      subjectType: 'flag_environment',
      subjectId: environment.id,
      payload: { before: environment.killRoles, after: roles },
    });
  }
}
