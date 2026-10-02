// The help center's services over a db (#96). Pure (no instance imports); instance.ts
// binds the production deps, tests bind pglite.
import { HelpAuthoringService } from '@backend/domain/helpcenter/HelpAuthoringService';
import { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { Db } from '@backend/infra/db/types';

export interface HelpDomain {
  helpSites: HelpSiteService;
  helpAuthoring: HelpAuthoringService;
  helpPublic: HelpPublicReadService;
}

export function createHelpDomain(db: Db, deps: { audit: Pick<AuditService, 'record'>; now?: () => Date }): HelpDomain {
  const helpSites = new HelpSiteService({ db, audit: deps.audit });
  const helpAuthoring = new HelpAuthoringService({
    db,
    audit: deps.audit,
    sites: helpSites,
    ...(deps.now !== undefined && { now: deps.now }),
  });
  return { helpSites, helpAuthoring, helpPublic: new HelpPublicReadService({ db }) };
}
