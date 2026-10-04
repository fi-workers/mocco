// Marks status pages dirty in the transaction of every change that affects them, then asks the
// `status.snapshot.publish` job to build a new version (ADR 0028). The mark is the durable part:
// if the enqueue fails or the job dies, the five-minute safety run still finds the page.
import { publishSnapshot } from '@backend/domain/status/jobs';
import { StatusPageRepo } from '@backend/domain/status/repos/page.repo';

import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

/** Records that a change affects a page's public view. */
export type TouchPage = (...pages: { workspaceId: string; pageId: string }[]) => void;

export interface SnapshotSchedulerDeps {
  db: Db;
  /** Undefined when no object store is configured: pages are still marked, nothing is enqueued. */
  queue: JobQueue | undefined;
  now: () => Date;
}

export class SnapshotScheduler {
  constructor(private readonly deps: SnapshotSchedulerDeps) {}

  /**
   * Run `write` in a transaction; every page it touches is marked dirty in the same transaction.
   * After the commit, a publish is requested for each.
   */
  async change<T>(write: (tx: Db, touch: TouchPage) => Promise<T>): Promise<T> {
    const touched: { workspaceId: string; pageId: string }[] = [];
    const touch: TouchPage = (...pages) => {
      touched.push(...pages);
    };
    const result = await this.deps.db.transaction(async tx => {
      const value = await write(tx, touch);
      await new StatusPageRepo(tx).markDirty(
        touched.map(page => page.pageId),
        this.deps.now(),
      );
      return value;
    });
    const byPage = new Map(touched.map(page => [page.pageId, page.workspaceId]));
    await this.request(
      [...byPage].map(([pageId, workspaceId]) => ({ pageId, workspaceId })),
      true,
    );
    return result;
  }

  /**
   * Enqueue a publish per page. Requests for a page whose job is still queued or running join
   * it (the dedupe key), so a burst of changes builds one or two versions, not one each.
   */
  async request(pages: readonly { pageId: string; workspaceId: string }[], shouldKick: boolean): Promise<void> {
    const { queue } = this.deps;
    if (queue === undefined) {
      return;
    }
    await Promise.all(
      pages.map(async ({ pageId, workspaceId }) => {
        try {
          await queue.enqueue(
            publishSnapshot,
            { pageId },
            { dedupeKey: `page:${pageId}`, workspaceId, kick: shouldKick },
          );
        } catch (error) {
          // The page stays dirty; the safety run publishes it.
          console.error('[status] snapshot publish request failed', { pageId, error });
        }
      }),
    );
  }
}
