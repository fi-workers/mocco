// Push for messenger replies (#95): contacts register their device's Expo push token, and
// a team reply is pushed to their devices unless they've already read it. Best effort:
// a failed send is logged by the job runner and retried; a device the push service says
// is gone is disabled.
import { MessengerLimits } from '@mocco/common/messenger';

import { MessengerConversationRepo } from '@backend/domain/messenger/repos/conversation.repo';
import { MessengerPushTokenRepo } from '@backend/domain/messenger/repos/push-token.repo';

import type { ContactPrincipal } from '@backend/domain/messenger/ContactMessengerService';
import type { PushSender } from '@backend/domain/messenger/push';
import type { Db } from '@backend/infra/db/types';
import type { PushTokenInput } from '@mocco/common/messenger';

export interface MessengerPushDeps {
  db: Db;
  sender: PushSender;
  now?: () => Date;
}

/** The notification data apps read to open the conversation (`data.mocco === 'messenger'`). */
export const PUSH_DATA_KIND = 'messenger';

export class MessengerPushService {
  private readonly now: () => Date;

  constructor(private readonly deps: MessengerPushDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async registerToken(principal: ContactPrincipal, input: PushTokenInput): Promise<void> {
    const { contact } = principal;
    await new MessengerPushTokenRepo(this.deps.db).upsert({
      workspaceId: contact.workspaceId,
      projectId: contact.projectId,
      contactId: contact.id,
      provider: input.provider,
      token: input.token,
      platform: input.platform,
      lastSeenAt: this.now(),
    });
  }

  async unregisterToken(principal: ContactPrincipal, token: string): Promise<void> {
    const { contact } = principal;
    await new MessengerPushTokenRepo(this.deps.db).remove(contact.projectId, contact.id, token);
  }

  /** Push the team's message `seq` to the contact's devices. Returns how many were sent. */
  async deliverReply(input: { conversationId: string; seq: number }): Promise<number> {
    const conversation = await new MessengerConversationRepo(this.deps.db).findById(input.conversationId);
    // Read already (the app was open), or not the team's newest public message any more.
    if (conversation === undefined || conversation.contactLastReadSeq >= input.seq) {
      return 0;
    }
    const tokens = new MessengerPushTokenRepo(this.deps.db);
    const devices = await tokens.activeForContact(conversation.contactId);
    if (devices.length === 0) {
      return 0;
    }
    const content = await new MessengerConversationRepo(this.deps.db).pushContent(
      conversation.id,
      conversation.projectId,
      input.seq,
    );
    if (content === undefined) {
      return 0;
    }
    const results = await this.deps.sender.send(
      devices.map(device => ({
        to: device.token,
        title: content.projectName ?? 'New reply',

        body: content.body.replaceAll(/\s+/gu, ' ').slice(0, MessengerLimits.previewMax),
        data: { mocco: PUSH_DATA_KIND, conversationId: conversation.id },
      })),
    );
    const gone = new Set(results.filter(result => result.isDeviceGone).map(result => result.to));
    await tokens.disable(
      devices.filter(device => gone.has(device.token)).map(device => device.id),
      this.now(),
    );
    return results.filter(result => result.ok).length;
  }
}
