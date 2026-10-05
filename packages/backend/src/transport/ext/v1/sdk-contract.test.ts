// The SDKs ship wire types without a runtime schema library; this keeps them honest
// against the route schemas (platform foundations §11).
import { type whoamiResponseSchema } from '@mocco/common/apikey';
import {
  type helpV1ArticleSchema,
  type helpV1CollectionResultSchema,
  type helpV1FeedbackInputSchema,
  type helpV1FeedbackResultSchema,
  type helpV1SearchResultSchema,
  type helpV1SiteSchema,
} from '@mocco/common/help-v1';
import {
  type attachmentCreateInputSchema,
  type contactConversationSchema,
  type contactMessageSchema,
  type conversationCreateInputSchema,
  type messageCreateInputSchema,
  type messengerSessionInputSchema,
  type messengerSessionSchema,
  type pushTokenInputSchema,
} from '@mocco/common/messenger';
import {
  type clientEventsRequestSchema,
  type finalizeRequestSchema,
  type promotionResultSchema,
  type uploadRequestSchema,
  type UploadResponse,
} from '@mocco/common/ota-hosting';
import { describe, expectTypeOf, it } from 'vitest';

import type {
  HelpArticle,
  HelpCollection,
  HelpFeedbackRequest,
  HelpFeedbackResult,
  HelpSearchResult,
  HelpSite,
  MessengerAttachmentRequest,
  MessengerConversation,
  MessengerConversationRequest,
  MessengerMessage,
  MessengerMessageRequest,
  MessengerPushTokenRequest,
  MessengerSessionRequest,
  MessengerSessionResponse,
  OtaEventsRequest,
  OtaFinalizeRequest,
  OtaPromotionResult,
  OtaUploadRequest,
  OtaUploadResponse,
  WhoAmI,
} from '@mocco/sdk-core';
import type { z } from 'zod';

describe('SDK wire types match the /v1 schemas', () => {
  it('whoami: what the route answers is what the SDK types', () => {
    expectTypeOf<z.output<typeof whoamiResponseSchema>>().toExtend<WhoAmI>();
  });

  it('OTA events: what the SDK sends is what the route accepts', () => {
    expectTypeOf<OtaEventsRequest>().toExtend<z.input<typeof clientEventsRequestSchema>>();
  });

  it('OTA CI: the CLI sends what upload and finalize accept, and reads what they answer', () => {
    expectTypeOf<OtaUploadRequest>().toExtend<z.input<typeof uploadRequestSchema>>();
    expectTypeOf<OtaFinalizeRequest>().toExtend<z.input<typeof finalizeRequestSchema>>();
    expectTypeOf<UploadResponse>().toExtend<OtaUploadResponse>();
    expectTypeOf<z.output<typeof promotionResultSchema>>().toExtend<OtaPromotionResult>();
  });

  it('help: what the read routes answer is what the SDK types', () => {
    expectTypeOf<z.output<typeof helpV1SearchResultSchema>>().toExtend<HelpSearchResult>();
    expectTypeOf<z.output<typeof helpV1SiteSchema>>().toExtend<HelpSite>();
    expectTypeOf<z.output<typeof helpV1CollectionResultSchema>>().toExtend<{ collection: HelpCollection }>();
    expectTypeOf<z.output<typeof helpV1ArticleSchema>>().toExtend<HelpArticle>();
  });

  it('help feedback: what the SDK sends is accepted, and it reads what the route answers', () => {
    expectTypeOf<HelpFeedbackRequest>().toExtend<z.input<typeof helpV1FeedbackInputSchema>>();
    expectTypeOf<z.output<typeof helpV1FeedbackResultSchema>>().toExtend<HelpFeedbackResult>();
  });

  it('messenger: what the SDK sends is accepted, and what the routes answer is what it types', () => {
    expectTypeOf<MessengerSessionRequest>().toExtend<z.input<typeof messengerSessionInputSchema>>();
    expectTypeOf<MessengerConversationRequest>().toExtend<z.input<typeof conversationCreateInputSchema>>();
    expectTypeOf<MessengerMessageRequest>().toExtend<z.input<typeof messageCreateInputSchema>>();
    expectTypeOf<z.output<typeof messengerSessionSchema>>().toExtend<MessengerSessionResponse>();
    expectTypeOf<z.output<typeof contactConversationSchema>>().toExtend<MessengerConversation>();
    expectTypeOf<z.output<typeof contactMessageSchema>>().toExtend<MessengerMessage>();
    expectTypeOf<MessengerAttachmentRequest>().toExtend<z.input<typeof attachmentCreateInputSchema>>();
    expectTypeOf<MessengerPushTokenRequest>().toExtend<z.input<typeof pushTokenInputSchema>>();
  });
});
