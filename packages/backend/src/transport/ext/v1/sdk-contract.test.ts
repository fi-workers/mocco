// The SDKs ship wire types without a runtime schema library; this keeps them honest
// against the route schemas (platform foundations §11).
import { type whoamiResponseSchema } from '@mocco/common/apikey';
import {
  type attachmentCreateInputSchema,
  type contactConversationSchema,
  type contactMessageSchema,
  type conversationCreateInputSchema,
  type messageCreateInputSchema,
  type messengerSessionInputSchema,
  type messengerSessionSchema,
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
  MessengerAttachmentRequest,
  MessengerConversation,
  MessengerConversationRequest,
  MessengerMessage,
  MessengerMessageRequest,
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

  it('messenger: what the SDK sends is accepted, and what the routes answer is what it types', () => {
    expectTypeOf<MessengerSessionRequest>().toExtend<z.input<typeof messengerSessionInputSchema>>();
    expectTypeOf<MessengerConversationRequest>().toExtend<z.input<typeof conversationCreateInputSchema>>();
    expectTypeOf<MessengerMessageRequest>().toExtend<z.input<typeof messageCreateInputSchema>>();
    expectTypeOf<z.output<typeof messengerSessionSchema>>().toExtend<MessengerSessionResponse>();
    expectTypeOf<z.output<typeof contactConversationSchema>>().toExtend<MessengerConversation>();
    expectTypeOf<z.output<typeof contactMessageSchema>>().toExtend<MessengerMessage>();
    expectTypeOf<MessengerAttachmentRequest>().toExtend<z.input<typeof attachmentCreateInputSchema>>();
  });
});
