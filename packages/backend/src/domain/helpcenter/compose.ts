// The help center's services over a db (#96). Pure (no instance imports); instance.ts
// binds the production deps, tests bind pglite.
import { HelpAuthoringService } from '@backend/domain/helpcenter/HelpAuthoringService';
import { HelpFeedbackService } from '@backend/domain/helpcenter/HelpFeedbackService';
import { HelpImageService } from '@backend/domain/helpcenter/HelpImageService';
import { HelpImportService } from '@backend/domain/helpcenter/HelpImportService';
import { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import { HelpTranslationService } from '@backend/domain/helpcenter/HelpTranslationService';
import { submitHelpArticleToIndexNow } from '@backend/domain/helpcenter/jobs';
import { HelpRevalidation } from '@backend/domain/helpcenter/revalidate';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { HelpImageStorage } from '@backend/domain/helpcenter/HelpImageService';
import type { HelpPageRevalidator } from '@backend/domain/helpcenter/revalidate';
import type { Translator } from '@backend/domain/helpcenter/translate/Translator';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

export interface HelpDomain {
  helpSites: HelpSiteService;
  helpAuthoring: HelpAuthoringService;
  helpPublic: HelpPublicReadService;
  helpImport: HelpImportService;
  helpImages: HelpImageService;
  helpTranslations: HelpTranslationService;
  helpFeedback: HelpFeedbackService;
}

export function createHelpDomain(
  db: Db,
  deps: {
    audit: Pick<AuditService, 'record'>;
    storage?: HelpImageStorage;
    queue?: Pick<JobQueue, 'enqueue' | 'kick'>;
    translator?: Translator;
    /** Rebuilds public pages right after a change; without one they refresh within a minute. */
    revalidator?: HelpPageRevalidator;
    /** Queue an IndexNow submission after each public change (production only, #367). */
    indexNow?: boolean;
    /** Keys "Was this helpful?" visitor hashes; tests pass a constant. */
    feedbackSecret?: () => string;
    now?: () => Date;
  },
): HelpDomain {
  const helpSites = new HelpSiteService({ db, audit: deps.audit });
  const revalidation = new HelpRevalidation({
    db,
    ...(deps.revalidator !== undefined && { revalidator: deps.revalidator }),
  });
  const refresh = async (workspaceId: string, projectId: string, article: { shortId: string; slug: string }) => {
    await revalidation.article(workspaceId, projectId, article);
    if (deps.indexNow === true && deps.queue !== undefined) {
      // A background job: a failed or slow submission never holds up the change itself.
      // One queued submission per article: changes in quick succession ride the same job.
      await deps.queue.enqueue(
        submitHelpArticleToIndexNow,
        { workspaceId, projectId, shortId: article.shortId, slug: article.slug },
        { dedupeKey: `${projectId}:${article.shortId}`, workspaceId, kick: true },
      );
    }
  };
  const helpTranslations = new HelpTranslationService({
    db,
    sites: helpSites,
    ...(deps.translator !== undefined && { translator: deps.translator }),
    ...(deps.queue !== undefined && { queue: deps.queue }),
    onTranslated: refresh,
  });
  const helpAuthoring = new HelpAuthoringService({
    db,
    audit: deps.audit,
    sites: helpSites,
    onPublished: async (workspaceId, projectId, articleId) => {
      await helpTranslations.onPublished(workspaceId, projectId, articleId);
    },
    onPublicChange: refresh,
    ...(deps.now !== undefined && { now: deps.now }),
  });
  const helpImport = new HelpImportService({
    db,
    audit: deps.audit,
    sites: helpSites,
    authoring: helpAuthoring,
  });
  const helpImages = new HelpImageService({
    sites: helpSites,
    ...(deps.storage !== undefined && { storage: deps.storage }),
  });
  return {
    helpSites,
    helpAuthoring,
    helpPublic: new HelpPublicReadService({ db }),
    helpImport,
    helpImages,
    helpTranslations,
    helpFeedback: new HelpFeedbackService({
      db,
      secret:
        deps.feedbackSecret ??
        (() => {
          throw new Error('Help feedback needs a secret (AUTH_SECRET)');
        }),
      ...(deps.now !== undefined && { now: deps.now }),
    }),
  };
}
