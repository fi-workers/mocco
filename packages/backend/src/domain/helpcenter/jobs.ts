// The help center's job handlers (#96), as pure factories. runtime/jobs.ts registers them.
import { z } from 'zod';

import { TranslationOutcomes } from '@backend/domain/helpcenter/translate/state';
import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';
import { RetryAt } from '@backend/domain/jobs/retry-at';

import type { HelpTranslationService } from '@backend/domain/helpcenter/HelpTranslationService';
import type { HelpIndexNow } from '@backend/domain/helpcenter/indexnow';

export const HelpJobKinds = {
  translate: 'help.translate',
  retranslateGlossary: 'help.retranslate-glossary',
  indexNow: 'help.indexnow',
} as const;

/** Translate a published article into one language; `fresh` skips translation memory ("Translate again"). */
export const translateHelpArticle = defineJob(
  HelpJobKinds.translate,
  z.object({
    articleId: z.uuid(),
    workspaceId: z.uuid(),
    locale: z.string().min(2).max(10),
    fresh: z.boolean().optional(),
  }),
);

/**
 * After a glossary edit (#214): queue a run for every translation whose article the edit
 * touches (its glossary hash in that language changed). Each run sends only the segments
 * containing a changed term; a reviewed language gets a proposal.
 */
export const retranslateHelpGlossary = defineJob(
  HelpJobKinds.retranslateGlossary,
  z.object({ workspaceId: z.uuid(), projectId: z.uuid() }),
);

/** Tell IndexNow the pages an article shows on changed (#367). */
export const submitHelpArticleToIndexNow = defineJob(
  HelpJobKinds.indexNow,
  z.object({
    workspaceId: z.uuid(),
    projectId: z.uuid(),
    shortId: z.string().min(1).max(20),
    slug: z.string().min(1).max(200),
  }),
);

export function createHelpHandlers(deps: {
  translations: HelpTranslationService;
  /** Undefined outside production: nothing is submitted, and the job is never enqueued. */
  indexNow?: HelpIndexNow;
}): JobHandler[] {
  const { indexNow } = deps;
  return [
    handleJob(translateHelpArticle, async (payload, ctx) => {
      // The run holds the translation as long as the job holds its lock.
      const result = await deps.translations.translateArticle(payload, { deadline: ctx.deadline });
      if (result.outcome === TranslationOutcomes.busy && result.retryAt !== undefined) {
        // Bounded by the other run's claim, which ends with its job's lock.
        throw new RetryAt(result.retryAt, 'another run is translating this language', { consumesAttempt: false });
      }
    }),
    handleJob(retranslateHelpGlossary, async payload => {
      await deps.translations.retranslateForGlossary(payload.workspaceId, payload.projectId);
    }),
    ...(indexNow === undefined
      ? []
      : [
          handleJob(submitHelpArticleToIndexNow, async payload => {
            await indexNow.submitArticle(payload.workspaceId, payload.projectId, {
              shortId: payload.shortId,
              slug: payload.slug,
            });
          }),
        ]),
  ];
}
