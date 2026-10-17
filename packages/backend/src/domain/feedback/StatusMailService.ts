// Telling a post's followers it moved (#180). Two steps, both run by the `feedback.status.mail`
// job every minute:
//
// - `fanOutDue` settles each status change two minutes after it was made (StatusMailPolicy.delay,
//   room to undo a slip): a change the post has since moved on from, one to under review, one
//   from creating or merging the post, one on a private board, or any change while this deployment
//   sends no email is settled with no mail. Otherwise each follower who can be mailed gets one
//   queued mail: an email voter (`email:` id) still following, whose vote counts, so an address
//   nobody confirmed is never mailed, and who hasn't stopped all mail from the project. Signed-in end users' addresses aren't stored; their app
//   tells them.
// - `sendQueued` sends queued mails, at most once each: a mail is claimed before it goes out, a
//   claim left by a run that died is given up, a follower who stopped following (the post, or all
//   of the project's mail) meanwhile is skipped, and a transient failure is tried again up to StatusMailPolicy.maxAttempts times.
import {
  FEEDBACK_NOTIFIED_STATUSES,
  FeedbackPostStatuses,
  FeedbackStatusChangeReasons,
  FeedbackStatusMailStates,
} from '@mocco/common/feedback';

import { EMAIL_END_USER_PREFIX, unsubscribeAllUrlOf } from '@backend/domain/feedback/EmailVoteService';
import { ChangelogEntryRepo } from '@backend/domain/feedback/repos/changelog-entry.repo';
import { FeedbackStatusMailRepo } from '@backend/domain/feedback/repos/status-mail.repo';
import { renderStatusMail } from '@backend/domain/feedback/status-mail';
import { EmailResultKinds } from '@backend/domain/notification/senders/email';

import type { FeedbackStatusChangeRow, FeedbackStatusMailRow } from '@backend/domain/feedback/repos/status-mail.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { EmailSender } from '@backend/domain/notification/senders/email';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackPostStatus } from '@mocco/common/feedback';

export const StatusMailPolicy = {
  /** How long a change waits before its mail goes out (an undo window). */
  delayMs: 2 * 60 * 1000,
  /** Changes one run settles. */
  changesPerRun: 50,
  /** Mails one run sends. */
  mailsPerRun: 200,
  /** Sends tried before a mail is given up. */
  maxAttempts: 5,
  /** A claim older than this belongs to a run that died. */
  claimTimeoutMs: 15 * 60 * 1000,
} as const;

export interface StatusMailServiceDeps {
  db: Db;
  /** Undefined when this deployment sends no email: changes are settled with no mail. */
  email: EmailSender | undefined;
  /** The follower's one-click unsubscribe link (the same signed link vote-by-email mails carry). */
  unsubscribeUrlOf: (scope: FeedbackScope, postId: string, endUserId: string) => string;
  /** The absolute URL of a path on the project's public site, or null when it has none. */
  publicUrlOf: (scope: FeedbackScope, path: string) => Promise<string | null>;
  now?: () => Date;
}

const NOTIFIED = new Set<FeedbackPostStatus>(FEEDBACK_NOTIFIED_STATUSES);
const SILENT_REASONS = new Set<string>([FeedbackStatusChangeReasons.created, FeedbackStatusChangeReasons.merge]);

const isNotified = (status: FeedbackPostStatus): status is (typeof FEEDBACK_NOTIFIED_STATUSES)[number] =>
  NOTIFIED.has(status);

export class StatusMailService {
  constructor(private readonly deps: StatusMailServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Whether the change mails anyone, before looking at its followers. */
  private async isWorthMailing(repo: FeedbackStatusMailRepo, change: FeedbackStatusChangeRow): Promise<boolean> {
    if (this.deps.email === undefined || SILENT_REASONS.has(change.reason) || !NOTIFIED.has(change.toStatus)) {
      return false;
    }
    if (await repo.hasNewerChange(change)) {
      return false;
    }
    const context = await repo.postContext(change.postId);
    return context?.isPublic === true && context.mergedIntoPostId === null && context.status === change.toStatus;
  }

  /** What every mail about one change shares: read once per run, not once per follower. */
  private async loadChange(repo: FeedbackStatusMailRepo, statusChangeId: string) {
    const change = await repo.findChange(statusChangeId);
    const context = change === undefined ? undefined : await repo.postContext(change.postId);
    if (change === undefined || context === undefined || !isNotified(change.toStatus)) {
      return undefined;
    }
    const scope = { workspaceId: context.workspaceId, projectId: context.projectId };
    const [entry] =
      change.toStatus === FeedbackPostStatuses.shipped
        ? await new ChangelogEntryRepo(this.deps.db).listPublishedForPost(scope, change.postId, 1)
        : [];
    return {
      postId: change.postId,
      status: change.toStatus,
      context,
      scope,
      postUrl: await this.deps.publicUrlOf(scope, `/feedback/${context.boardSlug}/${String(context.number)}`),
      changelogUrl:
        entry === undefined
          ? null
          : await this.deps.publicUrlOf(scope, `/feedback/${context.boardSlug}/changelog/${entry.slug}`),
    };
  }

  private async sendOne(
    repo: FeedbackStatusMailRepo,
    mail: FeedbackStatusMailRow,
    changes: Map<string, ReturnType<StatusMailService['loadChange']>>,
  ): Promise<boolean> {
    const loaded = changes.get(mail.statusChangeId) ?? this.loadChange(repo, mail.statusChangeId);
    changes.set(mail.statusChangeId, loaded);
    const about = await loaded;
    if (
      about === undefined ||
      this.deps.email === undefined ||
      !(await repo.isFollowing(about.postId, about.context.projectId, mail.endUserId))
    ) {
      await repo.settle(mail.id, { state: FeedbackStatusMailStates.skipped });
      return false;
    }
    const unsubscribeUrl = this.deps.unsubscribeUrlOf(about.scope, about.postId, mail.endUserId);
    const message = renderStatusMail({
      to: mail.endUserId.slice(EMAIL_END_USER_PREFIX.length),
      projectName: about.context.projectName,
      postTitle: about.context.title,
      status: about.status,
      postUrl: about.postUrl,
      changelogUrl: about.changelogUrl,
      unsubscribeUrl,
      unsubscribeAllUrl: unsubscribeAllUrlOf(unsubscribeUrl),
    });
    const result = await this.deps.email.send(message);
    if (result.kind === EmailResultKinds.sent) {
      await repo.settle(mail.id, { state: FeedbackStatusMailStates.sent, sentAt: this.now(), error: null });
      return true;
    }
    const isRetried = result.kind === EmailResultKinds.transient && mail.attempts < StatusMailPolicy.maxAttempts;
    await repo.settle(mail.id, {
      state: isRetried ? FeedbackStatusMailStates.queued : FeedbackStatusMailStates.failed,
      claimedAt: null,
      error: result.reason,
    });
    return false;
  }

  /** Settle the status changes whose undo window has passed; returns how many mails were queued. */
  async fanOutDue(): Promise<number> {
    const now = this.now();
    return await this.deps.db.transaction(async tx => {
      const repo = new FeedbackStatusMailRepo(tx);
      const due = await repo.lockDueChanges(
        new Date(now.getTime() - StatusMailPolicy.delayMs),
        StatusMailPolicy.changesPerRun,
      );
      let queued = 0;
      // eslint-disable-next-line no-restricted-syntax -- one change at a time, in the same transaction
      for (const change of due) {
        // eslint-disable-next-line no-await-in-loop -- see above
        if (await this.isWorthMailing(repo, change)) {
          // eslint-disable-next-line no-await-in-loop -- see above
          queued += await repo.queueForChange(change);
        }
        // eslint-disable-next-line no-await-in-loop -- see above
        await repo.markNotified(change.id, now);
      }
      return queued;
    });
  }

  /** Send queued mails; returns how many went out. */
  async sendQueued(): Promise<number> {
    const now = this.now();
    const repo = new FeedbackStatusMailRepo(this.deps.db);
    await repo.giveUpStale(new Date(now.getTime() - StatusMailPolicy.claimTimeoutMs));
    const claimed = await repo.claimQueued(now, StatusMailPolicy.mailsPerRun);
    const changes = new Map<string, ReturnType<StatusMailService['loadChange']>>();
    let sent = 0;
    // eslint-disable-next-line no-restricted-syntax -- one mail at a time keeps the relay's pace
    for (const mail of claimed) {
      // eslint-disable-next-line no-await-in-loop -- see above
      if (await this.sendOne(repo, mail, changes)) {
        sent++;
      }
    }
    return sent;
  }
}
