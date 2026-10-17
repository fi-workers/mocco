// Ship suggestions (#179): a release run shipped a post's linked work, and the team decides
// whether to mark it shipped. Accepting marks every waiting post of that run shipped (a status
// change with reason `ship_suggestion` by the team member, so the status mail follows as for any
// change); dismissing leaves the posts as they are. A board in `auto_apply` mode does the accepting
// itself, as no one (reason `auto_apply`). The suggestions themselves come from ShipDetector.
import { AuditActions } from '@mocco/common/audit';
import { FeedbackPostStatuses, FeedbackStatusChangeReasons, ShipSuggestionStates } from '@mocco/common/feedback';

import { FeedbackShipSuggestionNotFoundError } from '@backend/domain/feedback/errors';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { ShipSuggestionRepo } from '@backend/domain/feedback/repos/ship-suggestion.repo';
import { FeedbackStatusChangeRepo } from '@backend/domain/feedback/repos/status-change.repo';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { ShipSuggestionRow } from '@backend/domain/feedback/repos/ship-suggestion.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackPostStatus } from '@mocco/common/feedback';

export interface ShipSuggestionServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  boards: Pick<BoardService, 'requireBoard'>;
  now?: () => Date;
}

/** A run's suggestions on a board that wait for the team: what the inbox banner shows. */
export interface PendingShipRun {
  runId: string;
  commitSha: string;
  /** The resumed gates the release passed ("approved by"). */
  gateNames: string[];
  /** The draft changelog entry grouping the run's shipped posts, unless it was deleted. */
  changelogEntryId: string | null;
  suggestedAt: Date;
  posts: {
    suggestionId: string;
    id: string;
    number: number;
    title: string;
    status: FeedbackPostStatus;
    voteCount: number;
  }[];
}

const byText = (left: string, right: string) => (left < right ? -1 : 1);

/** How a decision marks the posts: by a team member, or by the board itself. */
const Deciders = {
  team: { state: ShipSuggestionStates.accepted, reason: FeedbackStatusChangeReasons.shipSuggestion },
  board: { state: ShipSuggestionStates.autoApplied, reason: FeedbackStatusChangeReasons.autoApply },
} as const;

export class ShipSuggestionService {
  constructor(private readonly deps: ShipSuggestionServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * Decide the run's waiting suggestions and mark their posts shipped, in one transaction: the
   * suggestions are locked first, then the posts in id order (as a merge locks them), so a post
   * merged or moved meanwhile is seen as it is now. A post already shipped, or merged into
   * another, has its suggestion decided without a change. Returns how many posts it shipped, or
   * undefined when nothing was waiting.
   */
  private async ship(
    scope: FeedbackScope,
    boardId: string,
    runId: string,
    decider: { by: string | null } & (typeof Deciders)[keyof typeof Deciders],
  ): Promise<number | undefined> {
    const now = this.now();
    const result = await this.deps.db.transaction(async tx => {
      const suggestions = new ShipSuggestionRepo(tx);
      const pending = await suggestions.lockPendingOfRun(scope, boardId, runId);
      if (pending.length === 0) {
        return undefined;
      }
      const posts = new FeedbackPostRepo(tx);
      const changes = new FeedbackStatusChangeRepo(tx);
      // Posts in id order, as a merge locks them.
      const ordered = pending.map(row => row.postId).toSorted(byText);
      const shipped: { suggestion: ShipSuggestionRow; post: FeedbackPostRow; from: FeedbackPostStatus }[] = [];
      // One post at a time: production's pool is a single connection.
      await ordered.reduce(async (previous, postId) => {
        await previous;
        const suggestion = pending.find(row => row.postId === postId);
        const current = await posts.findForUpdate(scope, postId);
        if (
          suggestion === undefined ||
          current === undefined ||
          current.mergedIntoPostId !== null ||
          current.status === FeedbackPostStatuses.shipped
        ) {
          return;
        }
        const post = await posts.setStatus(scope, current.id, { status: FeedbackPostStatuses.shipped, shippedAt: now });
        await changes.append({
          workspaceId: scope.workspaceId,
          postId: current.id,
          fromStatus: current.status,
          toStatus: FeedbackPostStatuses.shipped,
          reason: decider.reason,
          actorUserId: decider.by,
        });
        shipped.push({ suggestion, post, from: current.status });
      }, Promise.resolve());
      await suggestions.decide(
        scope.workspaceId,
        pending.map(row => row.id),
        { state: decider.state, by: decider.by, at: now },
      );
      return shipped;
    });
    if (result === undefined) {
      return undefined;
    }
    await result.reduce(async (previous, { suggestion, post, from }) => {
      await previous;
      await this.deps.audit.record(scope.workspaceId, {
        actorUserId: decider.by,
        action: AuditActions.feedbackShipped,
        subjectType: 'feedback_post',
        subjectId: post.id,
        payload: {
          projectId: scope.projectId,
          boardId: post.boardId,
          number: post.number,
          from,
          reason: decider.reason,
          runId: suggestion.runId,
          commitSha: suggestion.commitSha,
          suggestionId: suggestion.id,
        },
      });
    }, Promise.resolve());
    return result.length;
  }

  /** The board's waiting suggestions grouped by run, the newest run first. */
  async listPending(scope: FeedbackScope, boardId: string): Promise<PendingShipRun[]> {
    await this.deps.boards.requireBoard(scope, boardId);
    const rows = await new ShipSuggestionRepo(this.deps.db).pendingOnBoard(scope, boardId);
    // Rows come newest run first, so a run's first row starts its group.
    const runIds = [...new Set(rows.map(row => row.suggestion.runId))];
    return runIds.flatMap(runId => {
      const ofRun = rows.filter(row => row.suggestion.runId === runId);
      const [first] = ofRun;
      if (first === undefined) {
        return [];
      }
      return [
        {
          runId,
          commitSha: first.suggestion.commitSha,
          gateNames: first.suggestion.gateNames,
          changelogEntryId: first.suggestion.changelogEntryId,
          suggestedAt: first.suggestion.createdAt,
          posts: ofRun.map(({ suggestion, post }) => ({ suggestionId: suggestion.id, ...post })),
        },
      ];
    });
  }

  /** Mark every post of the run still waiting on the board shipped, as the team member. A run with
   * nothing waiting (decided already, or another project's) is FeedbackShipSuggestionNotFoundError. */
  async accept(
    scope: FeedbackScope,
    actorUserId: string,
    boardId: string,
    runId: string,
  ): Promise<{ shipped: number }> {
    const decided = await this.ship(scope, boardId, runId, { by: actorUserId, ...Deciders.team });
    if (decided === undefined) {
      throw new FeedbackShipSuggestionNotFoundError(runId);
    }
    return { shipped: decided };
  }

  /** The board's `auto_apply` mode: what accepting does, by no one, with reason `auto_apply`.
   * Nothing waiting is no change. */
  async autoApply(scope: FeedbackScope, boardId: string, runId: string): Promise<{ shipped: number }> {
    const decided = await this.ship(scope, boardId, runId, { by: null, ...Deciders.board });
    return { shipped: decided ?? 0 };
  }

  /** Set the run's waiting suggestions aside: the posts stay as they are. Not audited (nothing
   * changes for anyone). Nothing waiting is FeedbackShipSuggestionNotFoundError. */
  async dismiss(
    scope: FeedbackScope,
    actorUserId: string,
    boardId: string,
    runId: string,
  ): Promise<{ dismissed: number }> {
    const dismissed = await this.deps.db.transaction(async tx => {
      const repo = new ShipSuggestionRepo(tx);
      const pending = await repo.lockPendingOfRun(scope, boardId, runId);
      await repo.decide(
        scope.workspaceId,
        pending.map(row => row.id),
        { state: ShipSuggestionStates.dismissed, by: actorUserId, at: this.now() },
      );
      return pending.length;
    });
    if (dismissed === 0) {
      throw new FeedbackShipSuggestionNotFoundError(runId);
    }
    return { dismissed };
  }
}
