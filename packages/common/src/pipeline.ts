import { z } from 'zod';

import { moccoConfigSchema } from './mocco-config';

export const pipelineSchema = z.object({ id: z.string(), name: z.string(), createdAt: z.date() });
export type PipelineDto = z.infer<typeof pipelineSchema>;

export const pipelineVersionSchema = z.object({
  id: z.string(),
  definition: moccoConfigSchema,
  contentHash: z.string(),
  createdAt: z.date(),
});
export type PipelineVersionDto = z.infer<typeof pipelineVersionSchema>;
