// Asks for a subscriber fan-out from inside the transaction of the change that subscribers hear
// about (#156), so the notice commits or rolls back with the incident update or window change.
// The fan-out job runs on the next tick; it decides who gets what (SubscriberService.fanOut).
import { SubscriberMailKinds } from '@mocco/common/status';

import { fanOutToSubscribers } from '@backend/domain/status/jobs';

import type { JobQueue } from '@backend/domain/jobs/ports';
import type { SubscriberNotice } from '@backend/domain/status/jobs';
import type { Db } from '@backend/infra/db/types';

/** A notice's name: the dedupe key of its fan-out job and of every delivery it queues. */
export function noticeKeyOf(notice: SubscriberNotice): string {
  return notice.kind === SubscriberMailKinds.incidentUpdate
    ? `${notice.kind}:${notice.updateId}`
    : `${notice.kind}:${notice.maintenanceId}:${notice.status}`;
}

export class SubscriberNotices {
  constructor(private readonly queue: JobQueue) {}

  /** Enqueue a fan-out per notice in `tx`, the change's own transaction. */
  async request(tx: Db, notices: readonly SubscriberNotice[]): Promise<void> {
    await notices.reduce(async (previous, notice) => {
      await previous;
      await this.queue.enqueue(fanOutToSubscribers, notice, {
        executor: tx,
        dedupeKey: noticeKeyOf(notice),
        workspaceId: notice.workspaceId,
      });
    }, Promise.resolve());
  }
}
