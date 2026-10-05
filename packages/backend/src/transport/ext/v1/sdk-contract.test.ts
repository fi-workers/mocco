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
import {
  type incidentCreateInputSchema,
  type incidentUpdateInputSchema,
  type monitorInputSchema,
} from '@mocco/common/status';
import {
  type statusV1ComponentSchema,
  type statusV1ComponentStatusInputSchema,
  type statusV1IncidentComponentsInputSchema,
  type statusV1IncidentDetailSchema,
  type statusV1IncidentListSchema,
  type statusV1IncidentUpdateResultSchema,
  type statusV1LocationListSchema,
  type statusV1MaintenanceInputSchema,
  type statusV1MaintenanceSchema,
  type statusV1MonitorSchema,
  type statusV1MonitorUpsertResultSchema,
  type statusV1PageListSchema,
} from '@mocco/common/status-v1';
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
import type {
  StatusAffectedComponent,
  StatusComponent,
  StatusComponentStatus,
  StatusIncident,
  StatusIncidentCreateRequest,
  StatusIncidentDetail,
  StatusIncidentUpdate,
  StatusIncidentUpdateRequest,
  StatusLocation,
  StatusMaintenance,
  StatusMaintenanceRequest,
  StatusMonitor,
  StatusMonitorInput,
  StatusMonitorUpsertResult,
  StatusPage,
} from '@mocco/sdk-core/status';
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

  it('status: what the SDK sends is accepted, and what the routes answer is what it types', () => {
    expectTypeOf<StatusMonitorInput>().toExtend<z.input<typeof monitorInputSchema>>();
    expectTypeOf<StatusIncidentCreateRequest>().toExtend<z.input<typeof incidentCreateInputSchema>>();
    expectTypeOf<StatusIncidentUpdateRequest>().toExtend<z.input<typeof incidentUpdateInputSchema>>();
    expectTypeOf<{ components: StatusAffectedComponent[] }>().toExtend<
      z.input<typeof statusV1IncidentComponentsInputSchema>
    >();
    expectTypeOf<{ status: StatusComponentStatus }>().toExtend<z.input<typeof statusV1ComponentStatusInputSchema>>();
    expectTypeOf<StatusMaintenanceRequest>().toExtend<z.input<typeof statusV1MaintenanceInputSchema>>();

    expectTypeOf<z.output<typeof statusV1MonitorSchema>>().toExtend<StatusMonitor>();
    expectTypeOf<z.output<typeof statusV1MonitorUpsertResultSchema>>().toExtend<StatusMonitorUpsertResult>();
    expectTypeOf<z.output<typeof statusV1LocationListSchema>>().toExtend<{ locations: StatusLocation[] }>();
    expectTypeOf<z.output<typeof statusV1PageListSchema>>().toExtend<{ pages: StatusPage[] }>();
    expectTypeOf<z.output<typeof statusV1ComponentSchema>>().toExtend<StatusComponent>();
    expectTypeOf<z.output<typeof statusV1IncidentListSchema>>().toExtend<{ incidents: StatusIncident[] }>();
    expectTypeOf<z.output<typeof statusV1IncidentDetailSchema>>().toExtend<StatusIncidentDetail>();
    expectTypeOf<z.output<typeof statusV1IncidentUpdateResultSchema>>().toExtend<{
      incident: StatusIncident;
      update: StatusIncidentUpdate;
    }>();
    expectTypeOf<z.output<typeof statusV1MaintenanceSchema>>().toExtend<StatusMaintenance>();
  });
});
