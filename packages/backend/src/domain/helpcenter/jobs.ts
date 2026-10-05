// The help center's job handlers (#96), as pure factories. runtime/jobs.ts registers them.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { HelpTranslationService } from '@backend/domain/helpcenter/HelpTranslationService';
import type { HelpIndexNow } from '@backend/domain/helpcenter/indexnow';

export const HelpJobKinds = {
  translate: 'help.translate',
  indexNow: 'help.indexnow',
} as const;

/** Translate a published article into one language. */
export const translateHelpArticle = defineJob(
  HelpJobKinds.translate,
  z.object({ articleId: z.uuid(), workspaceId: z.uuid(), locale: z.string().min(2).max(10) }),
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
    handleJob(translateHelpArticle, async payload => {
      await deps.translations.translateArticle(payload);
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
