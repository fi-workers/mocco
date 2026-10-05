// "Was this helpful?" (#216): a reader's answer on a published article, from an app
// (/v1, the key names the project) or from the public site (by its slug). One answer per
// visitor, article and day is counted; a second one that day replaces the first. Not
// audited: a reader's vote is not a governance action.
//
// The visitor key is a keyed hash. A client sends an opaque id it generated and keeps
// (the SDK and the site's widget do), hashed with the project and a server secret, so it
// can't be linked across projects or reversed. Without one, the network address and user
// agent stand in, hashed together with the day, so the same reader is the same visitor
// for one day only. Raw addresses, user agents and client ids are never stored.
import { createHmac } from 'node:crypto';

import { ArticleStatuses } from '@mocco/common/help';
import { HELP_FEEDBACK_COMMENT_MAX } from '@mocco/common/help-v1';

import { HelpNodeNotFoundError, HelpSiteNotFoundError } from '@backend/domain/helpcenter/errors';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { HelpFeedbackRepo } from '@backend/domain/helpcenter/repos/feedback.repo';
import { HelpSiteRepo } from '@backend/domain/helpcenter/repos/site.repo';

import type { HelpSiteRow } from '@backend/domain/helpcenter/repos/site.repo';
import type { RateLimitRule } from '@backend/domain/ratelimit/ports';
import type { Db } from '@backend/infra/db/types';

/** The console shows answers from this many days back, today included. */
export const HELPFULNESS_WINDOW_DAYS = 30;
/** Answers a minute per client address, on /v1 and the public site: an app's users share its key. */
export const HELP_FEEDBACK_RATE_LIMIT: RateLimitRule = { limit: 30, windowSeconds: 60 };
const RECENT_COMMENTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Who answered: the client's own id, or (without one) where the request came from. */
export type HelpFeedbackVisitor = { visitorId: string } | { network: { address: string; userAgent: string } };

export interface HelpFeedbackAnswer {
  helpful: boolean;
  /** The reader's language subtag; the language they read in is stored. */
  locale?: string;
  comment?: string;
}

const ARTICLE_REF = /^([a-z0-9]{6})(?:-[a-z0-9-]*)?$/u;

/** The visitor-hash key for a deployment: its AUTH_SECRET, separated from every other use of it. */
export function helpFeedbackSecret(authSecret: string | undefined): string {
  if (authSecret === undefined) {
    throw new Error('Help feedback needs AUTH_SECRET');
  }
  return createHmac('sha256', authSecret).update('mocco help feedback visitor').digest('base64url');
}

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

export class HelpFeedbackService {
  constructor(
    private readonly deps: {
      db: Db;
      /** Keys the visitor hash (derived from the deployment's secret); read when first needed. */
      secret: () => string;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private visitorHash(projectId: string, visitor: HelpFeedbackVisitor, day: string): string {
    const material =
      'visitorId' in visitor
        ? `client\n${visitor.visitorId}`
        : `network\n${day}\n${visitor.network.address}\n${visitor.network.userAgent}`;
    return createHmac('sha256', this.deps.secret())
      .update(`${projectId}\n${material}`)
      .digest('base64url')
      .slice(0, 32);
  }

  private async record(site: HelpSiteRow, ref: string, answer: HelpFeedbackAnswer, visitor: HelpFeedbackVisitor) {
    const shortId = ARTICLE_REF.exec(ref)?.[1];
    const article =
      shortId === undefined
        ? undefined
        : await new HelpArticleRepo(this.deps.db).findByShortId(site.projectId, shortId);
    if (article?.status !== ArticleStatuses.published || article.workspaceId !== site.workspaceId) {
      throw new HelpNodeNotFoundError('article', ref);
    }
    const locale =
      answer.locale !== undefined && (answer.locale === site.sourceLocale || site.locales.includes(answer.locale))
        ? answer.locale
        : site.sourceLocale;
    const now = this.now();
    const day = utcDay(now);
    const comment = answer.comment?.trim().slice(0, HELP_FEEDBACK_COMMENT_MAX);
    const saved = await new HelpFeedbackRepo(this.deps.db).upsert(
      {
        workspaceId: site.workspaceId,
        projectId: site.projectId,
        articleId: article.id,
        locale,
        helpful: answer.helpful,
        comment: comment === undefined || comment === '' ? null : comment,
        visitorHash: this.visitorHash(site.projectId, visitor, day),
        day,
      },
      now,
    );
    return { counted: saved.inserted };
  }

  /** An answer on a published article of a project's help center (the /v1 surface). */
  async recordInProject(
    workspaceId: string,
    projectId: string,
    ref: string,
    answer: HelpFeedbackAnswer,
    visitor: HelpFeedbackVisitor,
  ) {
    const site = await new HelpSiteRepo(this.deps.db).find(workspaceId, projectId);
    if (site === undefined) {
      throw new HelpSiteNotFoundError(`project ${projectId}`);
    }
    return await this.record(site, ref, answer, visitor);
  }

  /** An answer on a published article of the help site at `slug` (the public site's widget). */
  async recordOnSite(slug: string, ref: string, answer: HelpFeedbackAnswer, visitor: HelpFeedbackVisitor) {
    const site = await new HelpSiteRepo(this.deps.db).findBySlug(slug);
    if (site === undefined) {
      throw new HelpSiteNotFoundError(slug);
    }
    return await this.record(site, ref, answer, visitor);
  }

  /** An article's answers over the last 30 days, and its newest comments (the console). */
  async helpfulness(workspaceId: string, projectId: string, articleId: string) {
    const article = await new HelpArticleRepo(this.deps.db).find(workspaceId, projectId, articleId);
    if (article === undefined) {
      throw new HelpNodeNotFoundError('article', articleId);
    }
    const since = utcDay(new Date(this.now().getTime() - (HELPFULNESS_WINDOW_DAYS - 1) * DAY_MS));
    const repo = new HelpFeedbackRepo(this.deps.db);
    const counts = await repo.counts(workspaceId, projectId, articleId, since);
    const recent = await repo.withComments(workspaceId, projectId, articleId, since, RECENT_COMMENTS);
    return {
      days: HELPFULNESS_WINDOW_DAYS,
      helpful: counts.find(row => row.helpful)?.count ?? 0,
      notHelpful: counts.find(row => !row.helpful)?.count ?? 0,
      comments: recent.map(row => ({
        helpful: row.helpful,
        comment: row.comment ?? '',
        locale: row.locale,
        createdAt: row.updatedAt,
      })),
    };
  }
}
