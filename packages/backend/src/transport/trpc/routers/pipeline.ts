// Pipeline domain router — slice 1 is preview only: parse a pasted `.mocco.yml`
// and return the parsed pipeline or the parse issues. No persistence — the
// config's real home is the repo, fetched at a run's commit (slice 2+).
import { moccoConfigSchema } from '@mocco/common/mocco-config';
import { z } from 'zod';

import { MoccoConfigParser } from '@backend/domain/pipeline/MoccoConfigParser';
import { decodeYaml } from '@backend/domain/pipeline/yaml/decode';
import { protectedProcedure, router } from '@backend/transport/trpc/trpc';

// Stateless (no DB, no vendor instance) — a plain domain object, constructed once.
const parser = new MoccoConfigParser(decodeYaml);

const issueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
  line: z.number().optional(),
});

/** Discriminated on `ok`: the parsed config, or the issues that rejected it. */
const previewOutputSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), config: moccoConfigSchema }),
  z.object({ ok: z.literal(false), stage: z.enum(['yaml', 'schema']), issues: z.array(issueSchema) }),
]);

export const pipelineRouter = router({
  preview: protectedProcedure
    .input(z.object({ source: z.string() }))
    .output(previewOutputSchema)
    .mutation(({ input }) => parser.parse(input.source)),
});
