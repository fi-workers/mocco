// The staff notice for ship suggestions (#180): one `feedback.ship.suggested` event per board and
// release run with posts waiting for the team, rendered when it is recorded (like the messenger and
// flag events) and routed by the workspace's notification rules. Pure.
import { FeedbackEventTypes } from '@mocco/common/events';
import { Severities } from '@mocco/common/notification';

import type { PublishInput } from '@backend/domain/events/EventBus';
import type { FeedbackBoardRow } from '@backend/domain/feedback/repos/board.repo';
import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';

/** Posts the notice names before summarizing the rest. */
const NOTICE_POSTS = 10;

// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** The dedupe key: one notice per board and run, however often the release is handled. */
export const shipNoticeDedupeKey = (boardId: string, runId: string): string =>
  `${FeedbackEventTypes.feedbackShipSuggested}:${boardId}:${runId}`;

/**
 * The notice for the posts a run shipped on a board that wait for the team: how many, which (the
 * first ten by number), the run's commit, the gates that approved it, and a link to the board's
 * inbox, where the banner marks them shipped.
 */
export function shipNoticeEvent(
  subject: {
    board: Pick<FeedbackBoardRow, 'id' | 'workspaceId' | 'projectId' | 'slug' | 'name'>;
    runId: string;
    commitSha: string;
    gateNames: readonly string[];
    posts: readonly Pick<FeedbackPostRow, 'number' | 'title'>[];
  },
  appOrigin: string | undefined,
): PublishInput {
  const { board, runId, commitSha, gateNames, posts } = subject;
  const count = posts.length;
  // eslint-disable-next-line sonarjs/null-dereference -- commitSha is a string, never null
  const sha = commitSha.slice(0, 7);
  const lines = posts.slice(0, NOTICE_POSTS).map(post => `• #${String(post.number)} ${clip(post.title, 150)}`);
  const more = count > NOTICE_POSTS ? `\n…and ${String(count - NOTICE_POSTS)} more` : '';
  return {
    type: FeedbackEventTypes.feedbackShipSuggested,
    workspaceId: board.workspaceId,
    projectId: board.projectId,
    subject: { type: 'feedback_board', id: board.id },
    dedupeKey: shipNoticeDedupeKey(board.id, runId),
    payload: {
      facts: { board: board.slug },
      message: {
        title: clip(`${String(count)} ${count === 1 ? 'post' : 'posts'} shipped on ${board.name} in run ${sha}`, 200),
        ...(appOrigin !== undefined && {
          url: `${appOrigin}/workspaces/${board.workspaceId}/p/${board.projectId}/feedback?board=${encodeURIComponent(board.slug)}`,
        }),
        description: clip(
          `${lines.join('\n')}${more}\n\nMark them shipped in the inbox to tell the people who voted.`,
          2000,
        ),
        severity: Severities.info,
        fields: [
          { name: 'Board', value: clip(board.name, 200), inline: true },
          { name: 'Posts', value: String(count), inline: true },
          { name: 'Commit', value: sha, inline: true },
          ...(gateNames.length === 0
            ? []
            : [{ name: 'Approved by', value: clip(gateNames.join(', '), 500), inline: false }]),
        ],
        footer: 'Mocco feedback',
      },
    },
  };
}
