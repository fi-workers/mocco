// The help center's job handlers (#96), as pure factories. runtime/jobs.ts registers them.
import { z } from 'zod';

import { defineJob, handleJob, type JobHandler } from '@backend/domain/jobs/handlers';

import type { HelpTranslationService } from '@backend/domain/helpcenter/HelpTranslationService';

export const HelpJobKinds = {
  translate: 'help.translate',
} as const;

/** Translate a published article into one language. */
export const translateHelpArticle = defineJob(
  HelpJobKinds.translate,
  z.object({ articleId: z.uuid(), workspaceId: z.uuid(), locale: z.string().min(2).max(10) }),
);

export function createHelpHandlers(deps: { translations: HelpTranslationService }): JobHandler[] {
  return [
    handleJob(translateHelpArticle, async payload => {
      await deps.translations.translateArticle(payload);
    }),
  ];
}
