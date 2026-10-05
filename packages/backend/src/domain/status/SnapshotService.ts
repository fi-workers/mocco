// Builds and publishes a status page's public snapshot (ADR 0028, #149). Runs as the
// `status.snapshot.publish` job: per page when a change marks it dirty, and every five minutes
// as a safety run that picks up pages whose request was lost or whose upload failed.
import { createHash } from 'node:crypto';

import { ComponentDayRepo } from '@backend/domain/status/repos/component-day.repo';
import { ComponentGroupRepo } from '@backend/domain/status/repos/component-group.repo';
import { IncidentComponentRepo } from '@backend/domain/status/repos/incident-component.repo';
import { IncidentUpdateRepo } from '@backend/domain/status/repos/incident-update.repo';
import { IncidentRepo } from '@backend/domain/status/repos/incident.repo';
import { MaintenanceComponentRepo } from '@backend/domain/status/repos/maintenance-component.repo';
import { MaintenanceRepo } from '@backend/domain/status/repos/maintenance.repo';
import { PageSnapshotRepo } from '@backend/domain/status/repos/page-snapshot.repo';
import { StatusPageRepo } from '@backend/domain/status/repos/page.repo';
import { publicSnapshotSchema } from '@backend/domain/status/snapshot/format';
import { projectSnapshot, uptimeBarDays } from '@backend/domain/status/snapshot/project';
import { renderAtomFeed, renderStatusPage } from '@backend/domain/status/snapshot/render';

import type { ComponentStatusService } from '@backend/domain/status/ComponentStatusService';
import type { PageSnapshotRow } from '@backend/domain/status/repos/page-snapshot.repo';
import type { StatusPageRow } from '@backend/domain/status/repos/page.repo';
import type { PublicSnapshot, SnapshotPointer } from '@backend/domain/status/snapshot/format';
import type { SnapshotScheduler } from '@backend/domain/status/SnapshotScheduler';
import type { StaticPublisher } from '@backend/domain/status/StaticPublisher';
import type { Db } from '@backend/infra/db/types';

export const SnapshotPolicy = {
  /** Versions kept in mocco_status_page_snapshots (and in the store). */
  keepVersions: 20,
  /** Resolved incidents on the page. */
  resolvedIncidents: 50,
  /** Builds one job runs back to back while changes keep arriving during a build. */
  maxBuildsPerRun: 3,
  /** Pages one safety run requests. */
  sweepBatch: 100,
} as const;

export interface SnapshotServiceDeps {
  db: Db;
  publisher: StaticPublisher;
  scheduler: Pick<SnapshotScheduler, 'request'>;
  componentStatus: ComponentStatusService;
  now?: () => Date;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export class SnapshotService {
  constructor(private readonly deps: SnapshotServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Upload a stored version and make it the live one. A failure is recorded on the version
   * (the console shows it) and retried by the safety run; it doesn't fail the job. */
  private async upload(page: StatusPageRow, row: PageSnapshotRow): Promise<boolean> {
    const snapshot = publicSnapshotSchema.parse(row.body);
    const pointer: SnapshotPointer = { version: row.version, etag: row.etag, builtAt: snapshot.builtAt };
    const snapshots = new PageSnapshotRepo(this.deps.db);
    try {
      await this.deps.publisher.publish(page.slug, row.version, {
        snapshot: JSON.stringify(snapshot),
        page: renderStatusPage(snapshot, ''),
        versionPage: renderStatusPage(snapshot, '../../'),
        feed: renderAtomFeed(snapshot),
        pointer: JSON.stringify(pointer),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await snapshots.markFailed(row.id, message.slice(0, 500));
      console.error('[status] snapshot upload failed', { pageId: page.id, version: row.version, error });
      return false;
    }
    const now = this.now();
    await snapshots.markUploaded(row.id, now);
    await new StatusPageRepo(this.deps.db).markPublished(page.id, row.version, now);
    const pruned = await snapshots.prune(page.id, SnapshotPolicy.keepVersions);
    if (pruned.length > 0) {
      await this.deps.publisher.deleteVersions(page.slug, pruned);
    }
    return true;
  }

  /** The page's public snapshot as of now. Drafts are left out by the queries. */
  async build(page: StatusPageRow, version: number, builtAt: Date): Promise<PublicSnapshot> {
    const { db } = this.deps;
    const scope = { workspaceId: page.workspaceId, projectId: page.projectId };
    const [groups, components, incidents, maintenances] = await Promise.all([
      new ComponentGroupRepo(db).listForPage(scope, page.id),
      this.deps.componentStatus.forPage(scope, page.id, true),
      new IncidentRepo(db).listPublished(scope, page.id, SnapshotPolicy.resolvedIncidents),
      new MaintenanceRepo(db).listUpcoming(scope, page.id),
    ]);
    const incidentIds = [...incidents.open, ...incidents.resolved].map(incident => incident.id);
    const barDays = uptimeBarDays(builtAt);
    const [updates, incidentComponents, maintenanceComponents, componentDays] = await Promise.all([
      new IncidentUpdateRepo(db).listForIncidents(page.workspaceId, incidentIds),
      new IncidentComponentRepo(db).listForIncidents(page.workspaceId, incidentIds),
      new MaintenanceComponentRepo(db).listFor(
        page.workspaceId,
        maintenances.map(window => window.id),
      ),
      new ComponentDayRepo(db).listForComponents(
        page.workspaceId,
        components.map(component => component.id),
        barDays[0] ?? '',
        barDays.at(-1) ?? '',
      ),
    ]);
    return projectSnapshot(
      {
        page,
        groups,
        components,
        incidents,
        updates,
        incidentComponents,
        maintenances,
        maintenanceComponents,
        componentDays,
      },
      { version, builtAt },
    );
  }

  /**
   * Publish the page if it changed, was never published, or its newest version didn't upload.
   * When it changes again during the build, it is built again (up to `maxBuildsPerRun`).
   * Returns the live version, or null when the page is gone or nothing was uploaded.
   */
  async publish(pageId: string, round = 1): Promise<number | null> {
    const pages = new StatusPageRepo(this.deps.db);
    const page = await pages.findById(pageId);
    if (page === undefined) {
      return null;
    }
    const latest = await new PageSnapshotRepo(this.deps.db).latest(pageId);
    if (page.dirtyAt === null && latest !== undefined) {
      if (latest.uploadedAt === null) {
        return (await this.upload(page, latest)) ? latest.version : null;
      }
      return page.publishedVersion;
    }
    const builtAt = this.now();
    const version = (latest?.version ?? 0) + 1;
    const snapshot = await this.build(page, version, builtAt);
    const body = JSON.stringify(snapshot);
    const row = await this.deps.db.transaction(async tx => {
      const inserted = await new PageSnapshotRepo(tx).insert({
        workspaceId: page.workspaceId,
        projectId: page.projectId,
        pageId,
        version,
        etag: sha256(body).slice(0, 32),
        body: snapshot,
        builtAt,
      });
      if (page.dirtyAt !== null) {
        await new StatusPageRepo(tx).clearDirty(pageId, page.dirtyAt);
      }
      return inserted;
    });
    const isUploaded = await this.upload(page, row);
    const after = await pages.findById(pageId);
    if (isUploaded && after?.dirtyAt != null && round < SnapshotPolicy.maxBuildsPerRun) {
      return await this.publish(pageId, round + 1);
    }
    return isUploaded ? version : null;
  }

  /** The safety run: request a publish for every page with work left. */
  async sweep(): Promise<number> {
    const pages = await new StatusPageRepo(this.deps.db).needingPublish(SnapshotPolicy.sweepBatch);
    await this.deps.scheduler.request(
      pages.map(page => ({ pageId: page.id, workspaceId: page.workspaceId })),
      false,
    );
    return pages.length;
  }
}
