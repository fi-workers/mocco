// A project's help center (#96): turning it on with a public slug and its languages.
import { AuditActions } from '@mocco/common/audit';

import { HelpSiteExistsError, HelpSiteNotFoundError, HelpSlugTakenError } from '@backend/domain/helpcenter/errors';
import { HelpSiteRepo } from '@backend/domain/helpcenter/repos/site.repo';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { HelpSiteRow } from '@backend/domain/helpcenter/repos/site.repo';
import type { Db } from '@backend/infra/db/types';
import type { HelpSiteInput } from '@mocco/common/help';

export interface HelpSiteDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
}

const toDto = (site: HelpSiteRow) => ({
  slug: site.slug,
  sourceLocale: site.sourceLocale,
  locales: site.locales,
  createdAt: site.createdAt,
});

/** Map the slug's unique index to the domain error; rethrow anything else. */
async function slugChecked<T>(slug: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof UniqueConstraintError && error.constraint === 'mocco_help_sites_slug_uq') {
      throw new HelpSlugTakenError(slug, { cause: error });
    }
    throw error;
  }
}

export class HelpSiteService {
  constructor(private readonly deps: HelpSiteDeps) {}

  async get(workspaceId: string, projectId: string) {
    const site = await new HelpSiteRepo(this.deps.db).find(workspaceId, projectId);
    return site === undefined ? undefined : toDto(site);
  }

  /** The site, or HelpSiteNotFoundError. */
  async require(workspaceId: string, projectId: string): Promise<HelpSiteRow> {
    const site = await new HelpSiteRepo(this.deps.db).find(workspaceId, projectId);
    if (site === undefined) {
      throw new HelpSiteNotFoundError(`project ${projectId}`);
    }
    return site;
  }

  async enable(workspaceId: string, projectId: string, actorUserId: string, input: HelpSiteInput) {
    const repo = new HelpSiteRepo(this.deps.db);
    const site = await slugChecked(input.slug, async () => await repo.insert({ workspaceId, projectId, ...input }));
    if (site === undefined) {
      throw new HelpSiteExistsError(projectId);
    }
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.helpSiteEnabled,
      subjectType: 'project',
      subjectId: projectId,
      payload: { ...input },
    });
    return toDto(site);
  }

  async update(workspaceId: string, projectId: string, actorUserId: string, input: HelpSiteInput) {
    await this.require(workspaceId, projectId);
    const repo = new HelpSiteRepo(this.deps.db);
    const site = await slugChecked(input.slug, async () => await repo.update(workspaceId, projectId, input));
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action: AuditActions.helpSiteChanged,
      subjectType: 'project',
      subjectId: projectId,
      payload: { ...input },
    });
    return toDto(site);
  }
}
