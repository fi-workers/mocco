// Uptime history (#152): rolls the round verdicts and state changes up into hours, UTC days and
// component days, which outlive the raw time series they come from. Runs as the `status.rollup`
// job. Every write is an upsert of a value computed from scratch, so rolling the same hour or day
// up twice gives the same rows.
import { COMPONENT_STATUS_RANK, ComponentStatuses, MonitorStates, RoundVerdicts } from '@mocco/common/status';

import { monitorImpact } from '@backend/domain/status/component-status';
import { histOf, mergeHists, percentileOf } from '@backend/domain/status/latency-hist';
import { ComponentDayRepo } from '@backend/domain/status/repos/component-day.repo';
import { ComponentMonitorRepo } from '@backend/domain/status/repos/component-monitor.repo';
import { ComponentRepo } from '@backend/domain/status/repos/component.repo';
import { IncidentComponentRepo } from '@backend/domain/status/repos/incident-component.repo';
import { MaintenanceComponentRepo } from '@backend/domain/status/repos/maintenance-component.repo';
import { MonitorStateChangeRepo } from '@backend/domain/status/repos/monitor-state-change.repo';
import { MonitorRepo } from '@backend/domain/status/repos/monitor.repo';
import { RollupDailyRepo } from '@backend/domain/status/repos/rollup-daily.repo';
import { RollupHourlyRepo } from '@backend/domain/status/repos/rollup-hourly.repo';
import { RoundVerdictRepo } from '@backend/domain/status/repos/round-verdict.repo';
import { uptimePercentOf } from '@backend/domain/status/snapshot/format';
import {
  clip,
  clipAll,
  DAY_MS,
  DOWN_STATES,
  HOUR_MS,
  intervalsIn,
  lengthOf,
  overlapOf,
  stateIntervals,
  toSeconds,
  unionOf,
  uptimeRatio,
} from '@backend/domain/status/uptime';
import { utcDayFrom, utcDayOf } from '@backend/infra/db/day-partitions';

import type { ComponentDayRow } from '@backend/domain/status/repos/component-day.repo';
import type { MonitorStateChangeRow } from '@backend/domain/status/repos/monitor-state-change.repo';
import type { MonitorRow } from '@backend/domain/status/repos/monitor.repo';
import type { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import type { Interval, StateInterval } from '@backend/domain/status/uptime';
import type { Db } from '@backend/infra/db/types';
import type { ComponentStatus, MonitorState, RoundVerdict } from '@mocco/common/status';

export const RollupPolicy = {
  /** A round closes up to about a minute after its time; an hour is rolled up once it ended this
   * long ago, and a day is final once it ended this long ago. */
  settleMs: 10 * 60_000,
  /** Hours one run catches up on after the job didn't run for a while. */
  maxHoursPerRun: 24,
  /** For this long after a day is final, every run rolls it up again, for rounds that closed late. */
  recheckPreviousDayMs: 2 * HOUR_MS,
  /** Hourly rollups are kept this many days (`status.retention`). */
  hourlyRetentionDays: 90,
} as const;

const PAUSED: ReadonlySet<MonitorState> = new Set([MonitorStates.paused]);
/** A `degraded` round passed its checks, only slowly: it counts as ok. */
const PASSING: ReadonlySet<RoundVerdict> = new Set([RoundVerdicts.ok, RoundVerdicts.degraded]);
const UNBOUNDED = Infinity;

const floorHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
const dayStartOf = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  return rows.reduce((groups, row) => {
    const k = key(row);
    const group = groups.get(k);
    if (group === undefined) {
      groups.set(k, [row]);
    } else {
      group.push(row);
    }
    return groups;
  }, new Map<string, T[]>());
}

/** A monitor's states over `window`. */
const spansOf = (
  monitor: MonitorRow,
  changesOf: ReadonlyMap<string, readonly MonitorStateChangeRow[]>,
  window: Interval,
): StateInterval[] => stateIntervals(changesOf.get(monitor.id) ?? [], monitor.state, window);

/** The part of `window` a row existed for: from its creation on. */
const existedIn = (createdAt: Date, window: Interval) => clip({ start: createdAt.getTime(), end: UNBOUNDED }, window);

/** The worst of the statuses, `operational` for none. */
const worstOf = (statuses: readonly ComponentStatus[]): ComponentStatus =>
  statuses.reduce<ComponentStatus>(
    (worst, status) => (COMPONENT_STATUS_RANK[status] > COMPONENT_STATUS_RANK[worst] ? status : worst),
    ComponentStatuses.operational,
  );

export interface RollupRun {
  /** The hours rolled up (their start). */
  hours: Date[];
  /** The days rolled up (`YYYY-MM-DD`). */
  days: string[];
}

/** Whether a component day changed what its bar shows: its status or its uptime percentage. */
const isBarChanged = (
  before: ComponentDayRow | undefined,
  after: Pick<ComponentDayRow, 'worstStatus' | 'uptimeRatio'>,
) =>
  before === undefined ||
  before.worstStatus !== after.worstStatus ||
  uptimePercentOf(before.uptimeRatio) !== uptimePercentOf(after.uptimeRatio);

export interface RollupServiceDeps {
  db: Db;
  /** Marks a page dirty, in the write's transaction, when the rollup changes one of its bars. */
  snapshots: Pick<SnapshotScheduler, 'change'>;
}

export class RollupService {
  constructor(private readonly deps: RollupServiceDeps) {}

  /**
   * One run of the job: every hour that ended at least `settleMs` ago and isn't rolled up yet
   * (at most `maxHoursPerRun`), then the current day so far, then the previous day while it is
   * within `recheckPreviousDayMs` of being final. So a day's rows are final from 00:10 UTC the
   * next day, and are rolled up once more on each run until 02:10.
   */
  async run(now: Date): Promise<RollupRun> {
    const settled = now.getTime() - RollupPolicy.settleMs;
    const end = floorHour(settled);
    // The hours after the latest one rolled up; with none yet (no monitor has had a round), the
    // last three, which costs nothing when they are empty.
    const latest = await new RollupHourlyRepo(this.deps.db).latestHour();
    const first = Math.max(
      latest === null ? end - 3 * HOUR_MS : latest.getTime() + HOUR_MS,
      end - RollupPolicy.maxHoursPerRun * HOUR_MS,
    );
    const hours = Array.from({ length: Math.max((end - first) / HOUR_MS, 0) }, (_, n) => new Date(first + n * HOUR_MS));
    await hours.reduce(async (previous, hour) => {
      await previous;
      await this.rollupHour(hour);
    }, Promise.resolve());

    const today = utcDayOf(new Date(settled));
    const days =
      settled - dayStartOf(today) < RollupPolicy.recheckPreviousDayMs
        ? [utcDayFrom(new Date(settled), -1), today]
        : [today];
    await days.reduce(async (previous, day) => {
      await previous;
      await this.rollupDay(day, now);
    }, Promise.resolve());
    return { hours, days };
  }

  /** Roll up one hour (its start) for every monitor that had rounds or downtime in it. */
  async rollupHour(hour: Date): Promise<void> {
    const { db } = this.deps;
    const window = { start: hour.getTime(), end: hour.getTime() + HOUR_MS };
    const [verdicts, changes, monitors] = await Promise.all([
      new RoundVerdictRepo(db).listBetween(hour, new Date(window.end)),
      new MonitorStateChangeRepo(db).listForWindow(hour, new Date(window.end)),
      new MonitorRepo(db).listCreatedBefore(new Date(window.end)),
    ]);
    const verdictsOf = groupBy(verdicts, row => row.monitorId);
    const changesOf = groupBy(changes, row => row.monitorId);
    const rows = monitors.flatMap(monitor => {
      const rounds = verdictsOf.get(monitor.id) ?? [];
      const existed = existedIn(monitor.createdAt, window);
      const downMs =
        existed === undefined ? 0 : lengthOf(intervalsIn(spansOf(monitor, changesOf, existed), DOWN_STATES));
      if (rounds.length === 0 && downMs === 0) {
        return [];
      }
      // A round's latency is its median across the locations that reported it.
      const latencies = rounds.flatMap(round => (round.p50LatencyMs === null ? [] : [round.p50LatencyMs]));
      return [
        {
          monitorId: monitor.id,
          hour,
          workspaceId: monitor.workspaceId,
          rounds: rounds.length,
          okRounds: rounds.filter(round => PASSING.has(round.verdict)).length,
          failRounds: rounds.filter(round => round.verdict === RoundVerdicts.fail).length,
          unknownRounds: rounds.filter(round => round.verdict === RoundVerdicts.unknown).length,
          downSeconds: toSeconds(downMs),
          latencySumMs: latencies.reduce((sum, latency) => sum + latency, 0),
          latencyCount: latencies.length,
          latencyHist: histOf(latencies),
        },
      ];
    });
    await new RollupHourlyRepo(db).upsertMany(rows);
  }

  /**
   * Roll up one UTC day (`YYYY-MM-DD`) up to `now` (the whole day once it has ended): each
   * monitor's daily row, and each component's day. Returns the component days written.
   */
  async rollupDay(day: string, now: Date): Promise<ComponentDayRow[]> {
    const { db } = this.deps;
    const dayStart = dayStartOf(day);
    const window = { start: dayStart, end: Math.min(dayStart + DAY_MS, now.getTime()) };
    if (window.end <= window.start) {
      return [];
    }
    const from = new Date(window.start);
    const to = new Date(window.end);
    const [monitors, components, links, hours, changes, maintenances, incidents] = await Promise.all([
      new MonitorRepo(db).listCreatedBefore(to),
      new ComponentRepo(db).listCreatedBefore(to),
      new ComponentMonitorRepo(db).listAll(),
      new RollupHourlyRepo(db).listBetween(from, new Date(dayStart + DAY_MS)),
      new MonitorStateChangeRepo(db).listForWindow(from, to),
      new MaintenanceComponentRepo(db).ranBetween(from, to),
      new IncidentComponentRepo(db).publishedOpenBetween(from, to),
    ]);
    const changesOf = groupBy(changes, row => row.monitorId);
    const hoursOf = groupBy(hours, row => row.monitorId);
    const maintenanceOf = new Map(
      [...groupBy(maintenances, row => row.componentId)].map(([componentId, rows]) => [
        componentId,
        unionOf(
          clipAll(
            rows.flatMap(row =>
              row.start === null ? [] : [{ start: row.start.getTime(), end: row.end?.getTime() ?? UNBOUNDED }],
            ),
            window,
          ),
        ),
      ]),
    );
    const linksOfMonitor = groupBy(links, link => link.monitorId);
    const monitorById = new Map(monitors.map(monitor => [monitor.id, monitor]));

    const daily = monitors.flatMap(monitor => {
      const existed = existedIn(monitor.createdAt, window);
      if (existed === undefined) {
        return [];
      }
      const spans = spansOf(monitor, changesOf, existed);
      const paused = intervalsIn(spans, PAUSED);
      const down = intervalsIn(spans, DOWN_STATES);
      const maintenance = clipAll(
        (linksOfMonitor.get(monitor.id) ?? []).flatMap(link => maintenanceOf.get(link.componentId) ?? []),
        existed,
      );
      const maintenanceMs = lengthOf(maintenance) - overlapOf(maintenance, paused);
      const downMs = lengthOf(down);
      const own = hoursOf.get(monitor.id) ?? [];
      const latencyHist = mergeHists(own.map(row => row.latencyHist));
      return [
        {
          monitorId: monitor.id,
          day,
          workspaceId: monitor.workspaceId,
          rounds: own.reduce((sum, row) => sum + row.rounds, 0),
          okRounds: own.reduce((sum, row) => sum + row.okRounds, 0),
          downSeconds: toSeconds(downMs),
          maintenanceSeconds: toSeconds(maintenanceMs),
          uptimeRatio: uptimeRatio({
            observedMs: existed.end - existed.start - lengthOf(paused),
            downMs,
            maintenanceMs,
            downInMaintenanceMs: overlapOf(down, maintenance),
          }),
          latencyHist,
          p95Ms: percentileOf(latencyHist, 0.95),
        },
      ];
    });

    const linksOfComponent = groupBy(links, link => link.componentId);
    const incidentsOf = groupBy(incidents, row => row.componentId);
    const componentDays = components.flatMap(component => {
      const existed = existedIn(component.createdAt, window);
      if (existed === undefined) {
        return [];
      }
      const linked = (linksOfComponent.get(component.id) ?? []).flatMap(link => {
        const monitor = monitorById.get(link.monitorId);
        return monitor === undefined ? [] : [{ link, spans: spansOf(monitor, changesOf, existed) }];
      });
      const statuses: ComponentStatus[] = linked.flatMap(({ link, spans }) =>
        spans.flatMap(span => monitorImpact(span.state, link.impactWhenDown) ?? []),
      );
      const down = linked.flatMap(({ spans }) => intervalsIn(spans, DOWN_STATES));
      const open = (incidentsOf.get(component.id) ?? []).filter(
        row =>
          clip({ start: row.startedAt.getTime(), end: row.resolvedAt?.getTime() ?? UNBOUNDED }, existed) !== undefined,
      );
      statuses.push(...open.map(row => row.impact));
      const maintenance = clipAll(maintenanceOf.get(component.id) ?? [], existed);
      if (maintenance.length > 0) {
        statuses.push(ComponentStatuses.maintenance);
      }
      const downMs = lengthOf(down);
      return [
        {
          componentId: component.id,
          day,
          workspaceId: component.workspaceId,
          worstStatus: worstOf(statuses),
          downSeconds: toSeconds(downMs),
          uptimeRatio:
            linked.length === 0
              ? null
              : uptimeRatio({
                  observedMs: existed.end - existed.start,
                  downMs,
                  maintenanceMs: lengthOf(maintenance),
                  downInMaintenanceMs: overlapOf(down, maintenance),
                }),
          incidentIds: [...new Set(open.map(row => row.incidentId))].toSorted((a, b) => (a < b ? -1 : Number(a > b))),
        },
      ];
    });

    // A bar that changed marks its page dirty in the same transaction, and the debounced publish
    // follows the commit; a rollup that changes nothing visible publishes nothing.
    const before = await new ComponentDayRepo(db).listForDay(day);
    const previous = new Map(before.map(row => [row.componentId, row]));
    const pageOf = new Map(components.map(component => [component.id, component]));
    await this.deps.snapshots.change(async (tx, touch) => {
      await new RollupDailyRepo(tx).upsertMany(daily);
      await new ComponentDayRepo(tx).upsertMany(componentDays);
      touch(
        ...componentDays.flatMap(row => {
          const component = pageOf.get(row.componentId);
          return component !== undefined && isBarChanged(previous.get(row.componentId), row)
            ? [{ workspaceId: component.workspaceId, pageId: component.pageId }]
            : [];
        }),
      );
    });
    return componentDays;
  }
}
