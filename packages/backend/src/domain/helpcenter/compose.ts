// The help center's services over a db (#96). Pure (no instance imports); instance.ts
// binds the production deps, tests bind pglite.
import { HelpAuthoringService } from '@backend/domain/helpcenter/HelpAuthoringService';
import { HelpImportService } from '@backend/domain/helpcenter/HelpImportService';
import { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import { HelpTranslationService } from '@backend/domain/helpcenter/HelpTranslationService';
import { HelpRevalidation } from '@backend/domain/helpcenter/revalidate';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { HelpImageStorage } from '@backend/domain/helpcenter/HelpImportService';
import type { HelpPageRevalidator } from '@backend/domain/helpcenter/revalidate';
import type { Translator } from '@backend/domain/helpcenter/translate/Translator';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';

export interface HelpDomain {
  helpSites: HelpSiteService;
  helpAuthoring: HelpAuthoringService;
  helpPublic: HelpPublicReadService;
  helpImport: HelpImportService;
  helpTranslations: HelpTranslationService;
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
    ...(deps.storage !== undefined && { storage: deps.storage }),
  });
  return { helpSites, helpAuthoring, helpPublic: new HelpPublicReadService({ db }), helpImport, helpTranslations };
}
