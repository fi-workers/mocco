// The messenger's job handlers, as pure factories. runtime/jobs.ts registers them.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { MessengerPushService } from '@backend/domain/messenger/MessengerPushService';

export const MessengerJobKinds = {
  pushReply: 'messenger.push.reply',
} as const;

/** Push a team reply to the contact's devices. */
export const pushMessengerReply = defineJob(
  MessengerJobKinds.pushReply,
  z.object({ conversationId: z.uuid(), seq: z.int().min(1) }),
);

export function createMessengerHandlers(deps: { push: MessengerPushService }): JobHandler[] {
  return [
    handleJob(pushMessengerReply, async payload => {
      await deps.push.deliverReply(payload);
    }),
  ];
}
