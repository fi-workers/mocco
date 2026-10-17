// A messenger conversation as a feedback source (#182): the feedback domain's
// FeedbackSourceReader, read here so feedback/ never imports messenger's repos. The request is
// what the contact wrote (public messages only, never the team's internal notes); the requester
// is the contact's app user id when they were signed in, and unknown for a guest.
import { FEEDBACK_SOURCE_EXCERPT_MAX, FeedbackLimits } from '@mocco/common/feedback';
import { AuthorKinds } from '@mocco/common/messenger';

import { MessengerContactRepo } from '@backend/domain/messenger/repos/contact.repo';
import { MessengerConversationRepo } from '@backend/domain/messenger/repos/conversation.repo';

import type { FeedbackSourceReader } from '@backend/domain/feedback/IntakeService';
import type { Db } from '@backend/infra/db/types';

/** The contact's messages read for the request: the start of the conversation. */
const MESSAGES_READ = 50;
/** How long a suggested title is at most, in characters (a post title may be longer). */
const TITLE_SUGGESTION_MAX = 80;

/** The first line of `text`, shortened at a word to `max` characters. */
export function firstLine(text: string, max: number): string {
  // eslint-disable-next-line sonarjs/null-dereference -- text is a string, never null
  const line = (text.trim().split('\n', 1)[0] ?? '').trim();
  // eslint-disable-next-line sonarjs/null-dereference -- line is a string, never null
  if (line.length <= max) {
    return line;
  }
  const cut = line.slice(0, max - 1);
  // eslint-disable-next-line sonarjs/null-dereference -- cut is a string, never null
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function messengerFeedbackSource(db: Db): FeedbackSourceReader {
  return {
    async read(scope, conversationId) {
      const conversations = new MessengerConversationRepo(db);
      const conversation = /^[0-9a-f-]{36}$/u.test(conversationId)
        ? await conversations.findInProject(scope.workspaceId, scope.projectId, conversationId)
        : undefined;
      if (conversation === undefined) {
        return undefined;
      }
      const contact = await new MessengerContactRepo(db).find(
        scope.workspaceId,
        scope.projectId,
        conversation.contactId,
      );
      const messages = await conversations.messages(conversation.id, {
        afterSeq: 0,
        limit: MESSAGES_READ,
        publicOnly: true,
      });
      const words = messages
        .filter(({ message }) => message.authorKind === AuthorKinds.contact)
        .map(({ message }) => message.body.trim())
        .filter(body => body !== '')
        .join('\n\n');
      const request = words === '' ? conversation.preview : words;
      const excerpt =
        request.length <= FEEDBACK_SOURCE_EXCERPT_MAX
          ? request
          : `${request.slice(0, FEEDBACK_SOURCE_EXCERPT_MAX - 1)}…`;
      return {
        suggestedTitle: firstLine(request, Math.min(TITLE_SUGGESTION_MAX, FeedbackLimits.titleMax)),
        excerpt,
        endUserId: contact?.externalUserId ?? null,
      };
    },
  };
}
