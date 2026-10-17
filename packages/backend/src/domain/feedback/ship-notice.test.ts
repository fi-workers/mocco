import { domainEventPayloadSchemas, FeedbackEventTypes } from '@mocco/common/events';
import { describe, expect, it } from 'vitest';

import { shipNoticeEvent } from '@backend/domain/feedback/ship-notice';

const board = {
  id: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  projectId: '00000000-0000-4000-8000-000000000003',
  slug: 'mobile ideas',
  name: 'Mobile ideas',
};

describe('shipNoticeEvent', () => {
  it('names the first ten posts, then counts the rest, and parses as the catalog payload', () => {
    const posts = Array.from({ length: 12 }, (_, index) => ({ number: index + 1, title: `Idea ${String(index + 1)}` }));
    const event = shipNoticeEvent(
      { board, runId: 'run-1', commitSha: 'abcdef0123456', gateNames: [], posts },
      'https://mocco.test',
    );

    expect(event.type).toBe(FeedbackEventTypes.feedbackShipSuggested);
    const payload = domainEventPayloadSchemas[FeedbackEventTypes.feedbackShipSuggested].parse(event.payload);
    expect(payload.message.title).toBe('12 posts shipped on Mobile ideas in run abcdef0');
    expect(payload.message.url).toBe(
      `https://mocco.test/workspaces/${board.workspaceId}/p/${board.projectId}/feedback?board=mobile%20ideas`,
    );
    expect(payload.message.description).toContain('• #10 Idea 10\n…and 2 more');
    expect(payload.message.description).not.toContain('Idea 11');
    // No gate names, no "Approved by".
    expect(payload.message.fields.map(field => field.name)).toEqual(['Board', 'Posts', 'Commit']);
  });

  it('has no link without an app origin, and clips a long title', () => {
    const event = shipNoticeEvent(
      {
        board: { ...board, name: 'B'.repeat(300) },
        runId: 'run-1',
        commitSha: 'abcdef0',
        gateNames: ['sre'],
        posts: [{ number: 1, title: 'T'.repeat(400) }],
      },
      undefined,
    );
    const payload = domainEventPayloadSchemas[FeedbackEventTypes.feedbackShipSuggested].parse(event.payload);
    expect(payload.message.url).toBeUndefined();
    expect(payload.message.title).toHaveLength(200);
    expect(payload.message.title.startsWith('1 post shipped on B')).toBe(true);
    expect(event.dedupeKey).toBe(`feedback.ship.suggested:${board.id}:run-1`);
  });
});
