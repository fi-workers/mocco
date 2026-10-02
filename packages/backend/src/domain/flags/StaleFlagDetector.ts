// Stale-flag detection (#144): the daily job turns telemetry rollups and flag configs
// into findings (`stale.ts` decides), a weekly digest tells the project, and people
// dismiss findings until a date. Advisory: nothing here gates a change.
import { AuditActions } from '@mocco/common/audit';
import { FlagEventTypes } from '@mocco/common/events';
import { STALE_AFTER_DAYS, StaleKinds } from '@mocco/common/flags';
import { Severities } from '@mocco/common/notification';
import { and, eq } from 'drizzle-orm';

import { publishBestEffort } from '@backend/domain/events/ports';
import { StaleFindingNotFoundError } from '@backend/domain/flags/errors';
import { FlagConfigRepo } from '@backend/domain/flags/repos/flag-config.repo';
import { FlagEnvironmentRepo } from '@backend/domain/flags/repos/flag-environment.repo';
import { FlagEvalRollupRepo } from '@backend/domain/flags/repos/flag-eval-rollup.repo';
import { FlagStaleFindingRepo } from '@backend/domain/flags/repos/flag-stale-finding.repo';
import { FlagRepo } from '@backend/domain/flags/repos/flag.repo';
import { detectStale } from '@backend/domain/flags/stale';
import * as schema from '@backend/infra/db/schema';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { EventPublisher } from '@backend/domain/events/ports';
import type { Db } from '@backend/infra/db/types';
import type { StaleKind } from '@mocco/common/flags';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rollup buckets older than this are pruned (each flag's newest is kept). */
export const ROLLUP_RETENTION_DAYS = 90;
/** Flags the digest names before summarizing the rest. */
const DIGEST_FLAGS = 20;

const kindLabels: Record<StaleKind, string> = {
  [StaleKinds.unused]: 'not evaluated lately',
  [StaleKinds.neverEvaluated]: 'never evaluated',
  [StaleKinds.fullyRolledOut]: 'fully rolled out',
};

export interface StaleFlagDetectorDeps {
  db: Db;
  audit: AuditService;
  events?: EventPublisher;
  appOrigin?: string;
  staleDays?: number;
}

export class StaleFlagDetector {
  private readonly staleDays: number;

  constructor(private readonly deps: StaleFlagDetectorDeps) {
    this.staleDays = deps.staleDays ?? STALE_AFTER_DAYS;
  }

  /** Rewrite every project's findings. Returns how many projects and findings there are. */
  async detectAll(now = new Date()): Promise<{ projects: number; findings: number }> {
    const findingRepo = new FlagStaleFindingRepo(this.deps.db);
    const lastSeenRows = await new FlagEvalRollupRepo(this.deps.db).lastSeenByFlag();
    const projects = await findingRepo.projectsWithFlags();
    const counts = await Promise.all(
      projects.map(async ({ workspaceId, projectId }) => {
        const [flags, environments, configs] = await Promise.all([
          new FlagRepo(this.deps.db).listByProject(workspaceId, projectId),
          new FlagEnvironmentRepo(this.deps.db).listByProject(workspaceId, projectId),
          new FlagConfigRepo(this.deps.db).listForProjectWithChangedAt(workspaceId, projectId),
        ]);
        const lastSeen = new Map(
          lastSeenRows.filter(row => row.projectId === projectId).map(row => [row.flagKey, row.lastSeenAt]),
        );
        const desired = detectStale(
          {
            flags,
            environmentIds: environments.map(environment => environment.id),
            configs: configs.map(({ config, changedAt }) => ({ ...config, changedAt })),
            lastSeen,
          },
          now,
          this.staleDays,
        );
        await findingRepo.replaceForProject(workspaceId, projectId, desired, now);
        return desired.length;
      }),
    );
    return { projects: projects.length, findings: counts.reduce((sum, count) => sum + count, 0) };
  }

  /** Drop rollup buckets past retention. */
  async pruneRollups(now = new Date()): Promise<number> {
    return await new FlagEvalRollupRepo(this.deps.db).prune(new Date(now.getTime() - ROLLUP_RETENTION_DAYS * DAY_MS));
  }

  /** A project's findings; with `activeAt`, only those not dismissed at that time. */
  async list(workspaceId: string, projectId: string, activeAt?: Date, now = new Date()) {
    const rows = await new FlagStaleFindingRepo(this.deps.db).listByProject(workspaceId, projectId, activeAt);
    // A dismissal that has run out reads as none.
    return rows.map(row => ({
      ...row,
      dismissedUntil: row.dismissedUntil !== null && row.dismissedUntil > now ? row.dismissedUntil : null,
    }));
  }

  /** Hide a finding until `until`, or show it again (`null`). Audited. */
  async dismiss(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { findingId: string; until: Date | null },
  ) {
    const row = await new FlagStaleFindingRepo(this.deps.db).dismiss(
      workspaceId,
      projectId,
      input.findingId,
      input.until,
      actorUserId,
    );
    if (row === undefined) {
      throw new StaleFindingNotFoundError(input.findingId);
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.flagStaleDismissed,
      subjectType: 'flag',
      subjectId: row.flagId,
      payload: { kind: row.kind, until: input.until?.toISOString() ?? null },
    });
    return row;
  }

  /** Tell each project with active findings which flags look ready for cleanup.
   * Idempotent per project and week. Returns how many digests were published. */
  async sendDigests(now = new Date()): Promise<number> {
    const { events } = this.deps;
    if (events === undefined) {
      return 0;
    }
    const week = Math.floor(now.getTime() / (7 * DAY_MS));
    const projects = await new FlagStaleFindingRepo(this.deps.db).projectsWithFlags();
    const sent = await Promise.all(
      projects.map(async ({ workspaceId, projectId }) => {
        const findings = await this.list(workspaceId, projectId, now, now);
        if (findings.length === 0) {
          return false;
        }
        const [project] = await this.deps.db
          .select({ name: schema.projects.name })
          .from(schema.projects)
          .where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, workspaceId)));
        const flagKeys = [...new Set(findings.map(finding => finding.flagKey))];
        const lines = flagKeys.slice(0, DIGEST_FLAGS).map(key => {
          const kinds = findings.filter(finding => finding.flagKey === key).map(finding => kindLabels[finding.kind]);
          return `• ${key}: ${kinds.join(', ')}`;
        });
        const more = flagKeys.length > DIGEST_FLAGS ? `\n…and ${flagKeys.length - DIGEST_FLAGS} more` : '';
        const countOf = (kind: StaleKind) => String(findings.filter(finding => finding.kind === kind).length);
        await publishBestEffort(events, FlagEventTypes.flagStaleDigest, async () => {
          await Promise.resolve();
          return {
            type: FlagEventTypes.flagStaleDigest,
            workspaceId,
            projectId,
            subject: { type: 'project', id: projectId },
            dedupeKey: `${projectId}:stale:${week}`,
            payload: {
              facts: { flags: String(flagKeys.length) },
              message: {
                title:
                  `${flagKeys.length} flag${flagKeys.length === 1 ? '' : 's'} to clean up in ${project?.name ?? 'a project'}`.slice(
                    0,
                    256,
                  ),
                ...(this.deps.appOrigin !== undefined && {
                  url: `${this.deps.appOrigin}/workspaces/${workspaceId}/p/${projectId}/flags`,
                }),
                description: `These look ready to come out of your code.\n${lines.join('\n')}${more}`.slice(0, 2000),
                severity: Severities.info,
                fields: [
                  { name: 'Not evaluated lately', value: countOf(StaleKinds.unused), inline: true },
                  { name: 'Never evaluated', value: countOf(StaleKinds.neverEvaluated), inline: true },
                  { name: 'Fully rolled out', value: countOf(StaleKinds.fullyRolledOut), inline: true },
                ],
                footer: 'Mocco feature flags',
              },
            },
          };
        });
        return true;
      }),
    );
    return sent.filter(Boolean).length;
  }
}
