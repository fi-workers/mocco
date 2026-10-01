// The SDKs ship wire types without a runtime schema library; this keeps them honest
// against the route schemas (platform foundations §11).
import { type whoamiResponseSchema } from '@mocco/common/apikey';
import {
  type clientEventsRequestSchema,
  type finalizeRequestSchema,
  type promotionResultSchema,
  type uploadRequestSchema,
  type UploadResponse,
} from '@mocco/common/ota-hosting';
import { describe, expectTypeOf, it } from 'vitest';

import type {
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
});
