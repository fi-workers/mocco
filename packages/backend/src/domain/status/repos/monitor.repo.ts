import { MonitorStates } from '@mocco/common/status';
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';

import { AdvisoryLockNamespaces } from '@backend/infra/db/advisory-locks';
import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { StatusScope } from '@backend/domain/status/scope';
import type { Db } from '@backend/infra/db/types';
import type { MonitorState } from '@mocco/common/status';

export type MonitorRow = typeof schema.statusMonitors.$inferSelect;
type MonitorInsert = typeof schema.statusMonitors.$inferInsert;
/** The settings an operator edits; state and schedule belong to pause, resume and the evaluator. */
export type MonitorSettings = Pick<
  MonitorInsert,
  | 'name'
  | 'kind'
  | 'spec'
  | 'intervalSeconds'
  | 'confirmations'
  | 'recoveryConfirmations'
  | 'quorumMode'
  | 'incidentPolicy'
>;

const m = schema.statusMonitors;
const scoped = (scope: StatusScope) => and(eq(m.workspaceId, scope.workspaceId), eq(m.projectId, scope.projectId));

/** Data access for mocco_status_monitors. Scoped by workspace and project. */
export class MonitorRepo {
  constructor(private readonly db: Db) {}

  async list(scope: StatusScope): Promise<MonitorRow[]> {
    return await this.db.select().from(m).where(scoped(scope)).orderBy(asc(m.name), asc(m.createdAt)).limit(500);
  }

  async find(scope: StatusScope, id: string): Promise<MonitorRow | undefined> {
    const [row] = await this.db
      .select()
      .from(m)
      .where(and(scoped(scope), eq(m.id, id)));
    return row;
  }

  /** Take the monitor's state lock for the rest of the transaction, then read it. Every writer
   * of `state` (pause, resume, the evaluator) goes through here. Call inside a transaction only. */
  async lockForStateChange(scope: StatusScope, id: string): Promise<MonitorRow | undefined> {
    await this.db.execute(sql`SELECT pg_advisory_xact_lock(${AdvisoryLockNamespaces.statusMonitor}, hashtext(${id}))`);
    return await this.find(scope, id);
  }

  async insert(row: MonitorInsert): Promise<MonitorRow> {
    return expectOne(await this.db.insert(m).values(row).returning());
  }

  async updateSettings(scope: StatusScope, id: string, values: MonitorSettings): Promise<MonitorRow | undefined> {
    const [row] = await this.db
      .update(m)
      .set({ ...values, updatedAt: new Date() })
      .where(and(scoped(scope), eq(m.id, id)))
      .returning();
    return row;
  }

  /** The monitors whose current round has started (`next_round_at` passed), across all
   * workspaces, oldest round first: the evaluator's candidates. Paused monitors have no rounds. */
  async listRoundsStarted(now: Date, opts: { monitorIds?: readonly string[]; limit: number }): Promise<MonitorRow[]> {
    return await this.db
      .select()
      .from(m)
      .where(
        and(
          ne(m.state, MonitorStates.paused),
          lte(m.nextRoundAt, now),
          opts.monitorIds === undefined ? undefined : inArray(m.id, [...opts.monitorIds]),
        ),
      )
      .orderBy(asc(m.nextRoundAt))
      .limit(opts.limit);
  }

  /** The monitors of `projectIds` that aren't paused: the ones a release of those projects watches. */
  async listWatchable(workspaceId: string, projectIds: readonly string[]): Promise<MonitorRow[]> {
    if (projectIds.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(m)
      .where(
        and(eq(m.workspaceId, workspaceId), inArray(m.projectId, [...projectIds]), ne(m.state, MonitorStates.paused)),
      )
      .orderBy(asc(m.id));
  }

  /**
   * Start a deploy watch (under `lockForStateChange`): rounds before `watchUntil` run every
   * `intervalSeconds`, from `nextRoundAt`. A watch that already runs longer (a newer release's) is
   * kept; returns undefined then.
   */
  async startWatch(
    scope: StatusScope,
    id: string,
    watch: { watchUntil: Date; intervalSeconds: number; runId: string; nextRoundAt: Date; at: Date },
  ): Promise<MonitorRow | undefined> {
    const [row] = await this.db
      .update(m)
      .set({
        watchUntil: watch.watchUntil,
        watchIntervalSeconds: watch.intervalSeconds,
        watchRunId: watch.runId,
        nextRoundAt: watch.nextRoundAt,
        updatedAt: watch.at,
      })
      .where(and(scoped(scope), eq(m.id, id), or(isNull(m.watchUntil), lte(m.watchUntil, watch.watchUntil))))
      .returning();
    return row;
  }

  /** Move the monitor's next round (under `lockForStateChange`); the state and streaks stay. */
  async setNextRound(scope: StatusScope, id: string, nextRoundAt: Date, at: Date): Promise<MonitorRow> {
    return expectOne(
      await this.db
        .update(m)
        .set({ nextRoundAt, updatedAt: at })
        .where(and(scoped(scope), eq(m.id, id)))
        .returning(),
    );
  }

  /** Set the state, streaks and schedule (under `lockForStateChange`). */
  async setState(
    scope: StatusScope,
    id: string,
    values: {
      state: MonitorState;
      stateChangedAt?: Date;
      nextRoundAt?: Date;
      consecutiveFails?: number;
      consecutiveOks?: number;
      /** Set all three to null when the deploy watch ends. */
      watchUntil?: null;
      watchIntervalSeconds?: null;
      watchRunId?: null;
    },
    at: Date,
  ): Promise<MonitorRow> {
    return expectOne(
      await this.db
        .update(m)
        .set({ ...values, updatedAt: at })
        .where(and(scoped(scope), eq(m.id, id)))
        .returning(),
    );
  }

  async delete(scope: StatusScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(m)
      .where(and(scoped(scope), eq(m.id, id)))
      .returning({ id: m.id });
    return rows.length > 0;
  }
}
