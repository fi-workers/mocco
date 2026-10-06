// Translating a help center (#96, #212). Publishing an article queues a translation into
// each language the site offers. The job splits the published source into segments
// (markdown/segment.ts), takes every segment translation memory already knows (a
// person's text over the machine's), sends only the rest to the translator, checks each
// answer, and puts the article back together from the source's own tree. A source edit
// therefore re-sends only the segments it changed.
//
// The state machine lives in translate/state.ts. A person's text (`reviewed`) is never
// overwritten by a job: when the source changes, the job drafts a proposal beside it. A
// run claims the translation under an advisory lock, so two runs never translate the same
// one, and a run whose source is already translated does nothing. Characters sent to the
// translator are metered per workspace and month; past the allowance a language waits as
// `pending` with the reason.
//
// Review (#213): a person saves a language (or marks the machine's text reviewed), accepts
// the machine draft beside a stale reviewed one, or asks the machine again, which replaces a
// reviewed text only when confirmed. Each is audited, and the text lands as a new revision,
// so history keeps every person's and machine's version.
import { AuditActions } from '@mocco/common/audit';
import { RevisionKinds, SegmentOrigins, TranslationStates } from '@mocco/common/help';

import { revisionText } from '@backend/domain/helpcenter/content';
import {
  HelpLocaleNotOfferedError,
  HelpNodeNotFoundError,
  HelpNoProposalError,
  HelpNothingToPublishError,
  TranslationOverwriteRequiresConfirmationError,
} from '@backend/domain/helpcenter/errors';
import { translateHelpArticle } from '@backend/domain/helpcenter/jobs';
import { reassemble, reassembleTitle } from '@backend/domain/helpcenter/markdown/reassemble';
import { segmentMarkdown, segmentTitle, TITLE_SEGMENT_ID } from '@backend/domain/helpcenter/markdown/segment';
import { HelpArticleRepo } from '@backend/domain/helpcenter/repos/article.repo';
import { HelpNodeTranslationRepo } from '@backend/domain/helpcenter/repos/node-translation.repo';
import { HelpSegmentMemoryRepo } from '@backend/domain/helpcenter/repos/segment-memory.repo';
import { HelpSiteRepo } from '@backend/domain/helpcenter/repos/site.repo';
import { HelpTranslationUsageRepo } from '@backend/domain/helpcenter/repos/translation-usage.repo';
import { HelpTranslationRepo } from '@backend/domain/helpcenter/repos/translation.repo';
import { HelpTreeRepo } from '@backend/domain/helpcenter/repos/tree.repo';
import { alignedSegments } from '@backend/domain/helpcenter/translate/align';
import { segmentDiff } from '@backend/domain/helpcenter/translate/diff';
import { charactersOf, distinctByHash, translateMisses } from '@backend/domain/helpcenter/translate/pipeline';
import {
  ClaimDecisions,
  decideClaim,
  ResultTargets,
  resultTarget,
  stateWithoutResult,
  TranslationOutcomes,
} from '@backend/domain/helpcenter/translate/state';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { Segment } from '@backend/domain/helpcenter/markdown/segment';
import type { HelpArticleRow, HelpRevisionRow } from '@backend/domain/helpcenter/repos/article.repo';
import type { HelpNode } from '@backend/domain/helpcenter/repos/node-translation.repo';
import type { HelpTranslationRow } from '@backend/domain/helpcenter/repos/translation.repo';
import type { MachineResult } from '@backend/domain/helpcenter/translate/pipeline';
import type { TranslationOutcome } from '@backend/domain/helpcenter/translate/state';
import type { Translator } from '@backend/domain/helpcenter/translate/Translator';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { Db } from '@backend/infra/db/types';
import type { AuditAction } from '@mocco/common/audit';
import type { TranslationInput, TranslationState } from '@mocco/common/help';

export interface HelpTranslationDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  sites: Pick<HelpSiteService, 'require'>;
  /** Without a translator (no LLM configured), nothing is translated automatically. */
  translator?: Translator;
  queue?: Pick<JobQueue, 'enqueue' | 'kick'>;
  /** Runs after a language's text changes (refreshes the article's public pages). */
  onTranslated?: (workspaceId: string, projectId: string, article: { shortId: string; slug: string }) => Promise<void>;
  /** Characters a workspace may send to the translator per month (UTC); unlimited without. */
  monthlyCharacters?: number;
  now?: () => Date;
}

/** A revision's title and body, as review shows them. */
const textOf = (revision: HelpRevisionRow | undefined) =>
  revision === undefined ? null : { title: revision.title, body: revision.bodyMd };

/** A revision's segments: its title, then its body's, in order. */
const segmentsOf = (revision: HelpRevisionRow) => [segmentTitle(revision.title), ...segmentMarkdown(revision.bodyMd)];

/** How long a run without a job deadline holds a translation. */
const DEFAULT_CLAIM_MS = 10 * 60_000;

/** The month usage is counted in: its first day (UTC). */
const monthOf = (now: Date) => `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;

interface TranslationKey {
  workspaceId: string;
  articleId: string;
  locale: string;
}

/** A collection's or section's title that needs translating, as a segment of the run. */
interface NodeTitle {
  node: HelpNode;
  title: string;
  segment: Segment;
}

export class HelpTranslationService {
  constructor(private readonly deps: HelpTranslationDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async requireArticle(workspaceId: string, projectId: string, articleId: string): Promise<HelpArticleRow> {
    const article = await new HelpArticleRepo(this.deps.db).find(workspaceId, projectId, articleId);
    if (article === undefined) {
      throw new HelpNodeNotFoundError('article', articleId);
    }
    return article;
  }

  private async publishedSource(article: HelpArticleRow): Promise<HelpRevisionRow | undefined> {
    if (article.publishedRevisionId === null) {
      return undefined;
    }
    const [source] = await new HelpArticleRepo(this.deps.db).revisionsByIds([article.publishedRevisionId]);
    return source;
  }

  /**
   * Queue a run for one language. A reviewed language keeps its state (the run drafts a
   * proposal if it is stale) unless `force` asks to replace it; `fresh` skips translation
   * memory, for "Translate again".
   */
  private async queueLocale(
    key: TranslationKey,
    sourceHash: string,
    opts: { force?: boolean; fresh?: boolean } = {},
  ): Promise<void> {
    const { queue } = this.deps;
    if (queue === undefined || this.deps.translator === undefined) {
      return;
    }
    const repo = new HelpTranslationRepo(this.deps.db);
    const row = await repo.find(key.workspaceId, key.articleId, key.locale);
    const isClaimed = row?.claimedUntil !== null && row?.claimedUntil !== undefined && row.claimedUntil > this.now();
    if (!isClaimed && (opts.force === true || row?.state !== TranslationStates.reviewed)) {
      await repo.upsert({ ...key, state: TranslationStates.pending, lastError: null });
    }
    // One run per source: a publish during a run queues its own, which waits for the claim.
    const { job } = await queue.enqueue(
      translateHelpArticle,
      { ...key, ...(opts.fresh === true && { fresh: true }) },
      {
        dedupeKey: `${key.articleId}:${key.locale}:${sourceHash}${opts.fresh === true ? ':fresh' : ''}`,
        workspaceId: key.workspaceId,
      },
    );
    queue.kick(job.id);
  }

  /** The collection and section titles above the article that have no translation into `locale`, or an old one. */
  private async nodeTitles(article: HelpArticleRow, locale: string): Promise<NodeTitle[]> {
    const { workspaceId } = article;
    const found = await new HelpTreeRepo(this.deps.db).findSection(workspaceId, article.projectId, article.sectionId);
    if (found === undefined) {
      return [];
    }
    const existing = await new HelpNodeTranslationRepo(this.deps.db).inLocale(workspaceId, locale, {
      collectionIds: [found.collection.id],
      sectionIds: [found.section.id],
    });
    const nodes = [
      {
        node: { collectionId: found.collection.id },
        title: found.collection.title,
        current: existing.find(row => row.collectionId === found.collection.id)?.sourceTitle,
      },
      {
        node: { sectionId: found.section.id },
        title: found.section.title,
        current: existing.find(row => row.sectionId === found.section.id)?.sourceTitle,
      },
    ];
    return nodes
      .filter(({ title, current }) => current !== title)
      .map(({ node, title }, i) => ({ node, title, segment: { ...segmentTitle(title), id: `node${String(i)}` } }));
  }

  /** Take the translation for a run, under its lock. */
  private async claim(key: TranslationKey, sourceHash: string, until: Date, isFresh: boolean) {
    return await this.deps.db.transaction(async tx => {
      const repo = new HelpTranslationRepo(tx);
      await repo.lock(key.articleId, key.locale);
      const row = await repo.find(key.workspaceId, key.articleId, key.locale);
      const decision = decideClaim(row, sourceHash, this.now(), { fresh: isFresh });
      if (decision === ClaimDecisions.translate || decision === ClaimDecisions.propose) {
        await repo.upsert({
          ...key,
          state: decision === ClaimDecisions.translate ? TranslationStates.translating : TranslationStates.reviewed,
          claimedUntil: until,
        });
      }
      return { decision, before: row?.state, claimedUntil: row?.claimedUntil ?? null };
    });
  }

  /** Let go of a run's claim without a result: an outage, or the monthly allowance. */
  private async release(
    key: TranslationKey,
    before: TranslationState | undefined,
    reason: { kind: 'outage' } | { kind: 'allowance' | 'refused'; message: string },
  ): Promise<void> {
    await this.deps.db.transaction(async tx => {
      const repo = new HelpTranslationRepo(tx);
      await repo.lock(key.articleId, key.locale);
      const now = await repo.find(key.workspaceId, key.articleId, key.locale);
      await repo.upsert({
        ...key,
        state: stateWithoutResult(now, before, reason.kind),
        claimedUntil: null,
        ...(reason.kind !== 'outage' && { lastError: reason.message }),
      });
    });
  }

  /** Store a finished run's text where the state machine says, under the lock. */
  private async land(
    key: TranslationKey,
    source: HelpRevisionRow,
    text: { title: string; body: string },
  ): Promise<TranslationOutcome> {
    return await this.deps.db.transaction(async tx => {
      const repo = new HelpTranslationRepo(tx);
      await repo.lock(key.articleId, key.locale);
      const now = await repo.find(key.workspaceId, key.articleId, key.locale);
      const target = resultTarget(now, source.contentHash);
      if (target === ResultTargets.discard) {
        await repo.upsert({ ...key, state: TranslationStates.reviewed, claimedUntil: null });
        return TranslationOutcomes.upToDate;
      }
      const revision = await new HelpArticleRepo(tx).insertRevision({
        ...key,
        ...revisionText(text.title, text.body),
        kind: target === ResultTargets.current ? RevisionKinds.machine : RevisionKinds.proposal,
        authorUserId: null,
      });
      if (target === ResultTargets.proposal) {
        await repo.upsert({
          ...key,
          state: TranslationStates.reviewed,
          proposalRevisionId: revision.id,
          proposalSourceHash: source.contentHash,
          claimedUntil: null,
          lastError: null,
        });
        return TranslationOutcomes.proposed;
      }
      await repo.upsert({
        ...key,
        state: TranslationStates.auto,
        revisionId: revision.id,
        sourceHash: source.contentHash,
        proposalRevisionId: null,
        proposalSourceHash: null,
        claimedUntil: null,
        lastError: null,
      });
      return TranslationOutcomes.translated;
    });
  }

  /** Save the collection and section titles that came back; a refused one keeps showing the source title. */
  private async storeNodeTitles(key: TranslationKey, nodes: readonly NodeTitle[], byHash: ReadonlyMap<string, string>) {
    const repo = new HelpNodeTranslationRepo(this.deps.db);
    await Promise.all(
      nodes.map(async ({ node, title, segment }) => {
        const translated = byHash.get(segment.hash);
        if (translated === undefined) {
          return;
        }
        await repo.upsert({
          workspaceId: key.workspaceId,
          locale: key.locale,
          title: reassembleTitle(title, translated),
          sourceTitle: title,
          ...node,
        });
      }),
    );
  }

  /** The site's offered language, or HelpLocaleNotOfferedError. */
  private async requireLocale(workspaceId: string, projectId: string, locale: string): Promise<void> {
    const site = await this.deps.sites.require(workspaceId, projectId);
    if (!(site.locales as readonly string[]).includes(locale)) {
      throw new HelpLocaleNotOfferedError(locale);
    }
  }

  private async requirePublishedSource(article: HelpArticleRow): Promise<HelpRevisionRow> {
    const source = await this.publishedSource(article);
    if (source === undefined) {
      throw new HelpNothingToPublishError(article.id);
    }
    return source;
  }

  /**
   * Make `text` the language's reviewed text, by `actorUserId`, now: a new `human_edit`
   * revision (its author and time are the review's) under the translation's lock, and the
   * segments that line up with the source written to translation memory as the person's.
   * `check` sees the row under the lock first and throws to change nothing.
   */
  private async storeReviewed(
    key: TranslationKey & { projectId: string },
    source: HelpRevisionRow,
    actorUserId: string,
    text: { title: string; body: string },
    check?: (row: HelpTranslationRow | undefined) => void,
  ): Promise<string> {
    const { projectId, ...translation } = key;
    const revisionId = await this.deps.db.transaction(async tx => {
      const repo = new HelpTranslationRepo(tx);
      await repo.lock(key.articleId, key.locale);
      check?.(await repo.find(key.workspaceId, key.articleId, key.locale));
      const revision = await new HelpArticleRepo(tx).insertRevision({
        ...translation,
        ...revisionText(text.title, text.body),
        kind: RevisionKinds.humanEdit,
        authorUserId: actorUserId,
        createdAt: this.now(),
      });
      await repo.upsert({
        ...translation,
        state: TranslationStates.reviewed,
        revisionId: revision.id,
        sourceHash: source.contentHash,
        lastError: null,
        reviewedByUserId: actorUserId,
        proposalRevisionId: null,
        proposalSourceHash: null,
      });
      return revision.id;
    });
    await new HelpSegmentMemoryRepo(this.deps.db).put(
      { workspaceId: key.workspaceId, projectId, locale: key.locale },
      SegmentOrigins.human,
      alignedSegments({ title: source.title, body: source.bodyMd }, text),
    );
    return revisionId;
  }

  private async audited(
    workspaceId: string,
    actorUserId: string,
    action: AuditAction,
    articleId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action,
      subjectType: 'help_article',
      subjectId: articleId,
      payload,
    });
  }

  /** Whether this deployment translates (an LLM is configured). */
  get isAvailable(): boolean {
    return this.deps.translator !== undefined && this.deps.queue !== undefined;
  }

  /** After a publish: queue a run into every offered language (a reviewed one only drafts a proposal). */
  async onPublished(workspaceId: string, projectId: string, articleId: string): Promise<void> {
    const site = await this.deps.sites.require(workspaceId, projectId);
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    const source = await this.publishedSource(article);
    if (source === undefined) {
      return;
    }
    await Promise.all(
      site.locales.map(async locale => await this.queueLocale({ workspaceId, articleId, locale }, source.contentHash)),
    );
  }

  /**
   * The `help.translate` job: translate the published source into `locale`, segment by
   * segment. `deadline` is how long the run may hold the translation (the job's lock).
   */
  async translateArticle(
    input: TranslationKey & { fresh?: boolean },
    run: { deadline?: Date } = {},
  ): Promise<{ outcome: TranslationOutcome; retryAt?: Date }> {
    const { translator } = this.deps;
    if (translator === undefined) {
      return { outcome: TranslationOutcomes.skipped };
    }
    const key = { workspaceId: input.workspaceId, articleId: input.articleId, locale: input.locale };
    const [article] = await new HelpArticleRepo(this.deps.db).byIds(key.workspaceId, [key.articleId]);
    const source = article === undefined ? undefined : await this.publishedSource(article);
    const site =
      article === undefined ? undefined : await new HelpSiteRepo(this.deps.db).find(key.workspaceId, article.projectId);
    if (article === undefined || source === undefined || site === undefined) {
      return { outcome: TranslationOutcomes.skipped };
    }
    const isFresh = input.fresh === true;
    const until = run.deadline ?? new Date(this.now().getTime() + DEFAULT_CLAIM_MS);
    const claim = await this.claim(key, source.contentHash, until, isFresh);
    if (claim.decision === ClaimDecisions.busy) {
      return { outcome: TranslationOutcomes.busy, retryAt: claim.claimedUntil ?? until };
    }
    if (claim.decision === ClaimDecisions.upToDate) {
      return { outcome: TranslationOutcomes.upToDate };
    }

    const articleSegments = [segmentTitle(source.title), ...segmentMarkdown(source.bodyMd)];
    const nodes = await this.nodeTitles(article, key.locale);
    const segments = [...articleSegments, ...nodes.map(({ segment }) => segment)];
    const memoryScope = { workspaceId: key.workspaceId, projectId: article.projectId, locale: key.locale };
    const memory = new HelpSegmentMemoryRepo(this.deps.db);
    const entries = isFresh
      ? []
      : await memory.lookup(
          memoryScope,
          distinctByHash(segments).map(({ hash }) => hash),
        );
    const known = new Map(
      entries
        .toSorted((a, b) => Number(a.origin === SegmentOrigins.human) - Number(b.origin === SegmentOrigins.human))
        .map(entry => [entry.sourceHash, entry.text]),
    );
    const misses = distinctByHash(segments.filter(({ hash }) => !known.has(hash)));

    const usage = new HelpTranslationUsageRepo(this.deps.db);
    const month = monthOf(this.now());
    const reserved = charactersOf(misses);
    if (!(await usage.reserve(key.workspaceId, month, reserved, this.deps.monthlyCharacters))) {
      await this.release(key, claim.before, {
        kind: 'allowance',
        message: `Waiting: this workspace used its ${String(this.deps.monthlyCharacters ?? 0)} translated characters for the month.`,
      });
      return { outcome: TranslationOutcomes.overAllowance };
    }

    const missLength = new Map(misses.map(segment => [segment.hash, segment.text.length]));
    let accepted = 0;
    let result: MachineResult;
    try {
      result = await translateMisses(
        misses,
        { translator, sourceLocale: site.sourceLocale, targetLocale: key.locale },
        async batch => {
          // A checkpoint: a retried run finds these in memory instead of sending them again.
          await memory.put(
            memoryScope,
            SegmentOrigins.machine,
            batch.map(({ hash, text }) => ({ sourceHash: hash, text })),
          );
          accepted += batch.reduce((sum, { hash }) => sum + (missLength.get(hash) ?? 0), 0);
        },
      );
    } catch (error) {
      // An outage or a rate limit: give back what wasn't translated, let go, and let the job retry.
      await usage.refund(key.workspaceId, month, reserved - accepted);
      await this.release(key, claim.before, { kind: 'outage' });
      throw error;
    }

    const byHash = new Map([...known, ...result.translated]);
    await this.storeNodeTitles(key, nodes, byHash);
    const articleHashes = new Set(articleSegments.map(({ hash }) => hash));
    const refused = result.refused.filter(({ segment }) => articleHashes.has(segment.hash));
    const [first] = refused;
    if (first !== undefined) {
      const more = refused.length > 1 ? ` (and ${String(refused.length - 1)} more)` : '';
      await this.release(key, claim.before, {
        kind: 'refused',
        message: `The translation was refused: segment ${first.segment.id}: ${first.problem}${more}`,
      });
      return { outcome: TranslationOutcomes.refused };
    }
    const byId = new Map(
      articleSegments.flatMap(({ id, hash }) => {
        const text = byHash.get(hash);
        return text === undefined ? [] : [[id, text] as const];
      }),
    );
    const text = {
      title: reassembleTitle(source.title, byId.get(TITLE_SEGMENT_ID) ?? segmentTitle(source.title).text),
      body: reassemble(source.bodyMd, byId),
    };
    const outcome = await this.land(key, source, text);
    if (outcome === TranslationOutcomes.translated) {
      await this.deps.onTranslated?.(key.workspaceId, article.projectId, article);
    }
    return { outcome };
  }

  /** Every offered language of an article: its state, whether it's stale, and its text. */
  async translations(workspaceId: string, projectId: string, articleId: string) {
    const site = await this.deps.sites.require(workspaceId, projectId);
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    const articleRepo = new HelpArticleRepo(this.deps.db);
    const translationRows = await new HelpTranslationRepo(this.deps.db).forArticle(workspaceId, articleId);
    const rows = new Map(translationRows.map(row => [row.locale, row]));
    const revisionIds = translationRows.flatMap(row => (row.revisionId === null ? [] : [row.revisionId]));
    const source = await this.publishedSource(article);
    const revisions = await articleRepo.revisionsByIds(revisionIds);
    const texts = new Map(revisions.map(revision => [revision.id, revision]));
    return {
      isAvailable: this.isAvailable,
      locales: site.locales.map(locale => {
        const row = rows.get(locale);
        const text = texts.get(row?.revisionId ?? '');
        return {
          locale,
          state: row?.state ?? null,
          isStale:
            row?.sourceHash !== undefined &&
            row.sourceHash !== null &&
            source !== undefined &&
            row.sourceHash !== source.contentHash,
          /** A machine draft waits beside the reviewed text, made from the current source. */
          hasProposal:
            row?.proposalRevisionId !== undefined &&
            row.proposalRevisionId !== null &&
            source !== undefined &&
            row.proposalSourceHash === source.contentHash,
          lastError: row?.lastError ?? null,
          title: text?.title ?? null,
          body: text?.bodyMd ?? null,
          updatedAt: row?.updatedAt ?? null,
        };
      }),
    };
  }

  /**
   * A person's translation: stored as `reviewed`, made from the current published source,
   * with the reviewer and the time on its revision. Saving the machine's text unchanged
   * marks it reviewed. The segments that line up with the source go to translation memory,
   * so later runs reuse the person's sentences over the machine's.
   */
  async saveTranslation(workspaceId: string, projectId: string, actorUserId: string, input: TranslationInput) {
    await this.requireLocale(workspaceId, projectId, input.locale);
    const article = await this.requireArticle(workspaceId, projectId, input.articleId);
    const source = await this.requirePublishedSource(article);
    const key = { workspaceId, projectId, articleId: article.id, locale: input.locale };
    const revisionId = await this.storeReviewed(key, source, actorUserId, input);
    await this.audited(workspaceId, actorUserId, AuditActions.helpTranslationReviewed, article.id, {
      projectId,
      locale: input.locale,
      revisionId,
      sourceHash: source.contentHash,
    });
    await this.deps.onTranslated?.(workspaceId, projectId, article);
    return await this.translations(workspaceId, projectId, article.id);
  }

  /**
   * Accept the machine draft beside a stale reviewed translation: it becomes the reviewed
   * text, by this person, now. `proposalRevisionId` is the draft the reviewer saw; when a
   * newer one replaced it or the source moved on since, nothing changes (HelpNoProposalError).
   */
  async acceptProposal(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { articleId: string; locale: string; proposalRevisionId: string },
  ) {
    await this.requireLocale(workspaceId, projectId, input.locale);
    const article = await this.requireArticle(workspaceId, projectId, input.articleId);
    const source = await this.requirePublishedSource(article);
    const [proposal] = await new HelpArticleRepo(this.deps.db).revisionsByIds([input.proposalRevisionId]);
    if (
      proposal?.articleId !== article.id ||
      proposal.locale !== input.locale ||
      proposal.kind !== RevisionKinds.proposal
    ) {
      throw new HelpNoProposalError(input.locale);
    }
    const key = { workspaceId, projectId, articleId: article.id, locale: input.locale };
    const text = { title: proposal.title, body: proposal.bodyMd };
    const revisionId = await this.storeReviewed(key, source, actorUserId, text, row => {
      if (row?.proposalRevisionId !== proposal.id || row.proposalSourceHash !== source.contentHash) {
        throw new HelpNoProposalError(input.locale);
      }
    });
    await this.audited(workspaceId, actorUserId, AuditActions.helpTranslationProposalAccepted, article.id, {
      projectId,
      locale: input.locale,
      revisionId,
      proposalRevisionId: proposal.id,
      sourceHash: source.contentHash,
    });
    await this.deps.onTranslated?.(workspaceId, projectId, article);
    return await this.review(workspaceId, projectId, article.id, input.locale);
  }

  /**
   * Ask the machine again for one language, without translation memory. A reviewed
   * language is replaced only with `confirm` (TranslationOverwriteRequiresConfirmationError
   * otherwise); the result lands as a new `machine` revision, so the person's stays in history.
   */
  async retranslate(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: { articleId: string; locale: string; confirm?: boolean },
  ) {
    await this.requireLocale(workspaceId, projectId, input.locale);
    const article = await this.requireArticle(workspaceId, projectId, input.articleId);
    const source = await this.requirePublishedSource(article);
    const row = await new HelpTranslationRepo(this.deps.db).find(workspaceId, article.id, input.locale);
    const isReviewed = row?.state === TranslationStates.reviewed;
    if (isReviewed && input.confirm !== true) {
      throw new TranslationOverwriteRequiresConfirmationError(input.locale);
    }
    await this.queueLocale({ workspaceId, articleId: article.id, locale: input.locale }, source.contentHash, {
      force: true,
      fresh: true,
    });
    await this.audited(workspaceId, actorUserId, AuditActions.helpTranslationRetranslated, article.id, {
      projectId,
      locale: input.locale,
      replacesReviewed: isReviewed,
      sourceHash: source.contentHash,
    });
    return await this.translations(workspaceId, projectId, article.id);
  }

  /**
   * One language of an article, for review: the published source beside the current text,
   * who reviewed it and when, the machine draft if one waits for the current source, and,
   * when the source changed since the text was made, the segment diff from that source to
   * the published one.
   */
  async review(workspaceId: string, projectId: string, articleId: string, locale: string) {
    await this.requireLocale(workspaceId, projectId, locale);
    const article = await this.requireArticle(workspaceId, projectId, articleId);
    const articleRepo = new HelpArticleRepo(this.deps.db);
    const source = await this.publishedSource(article);
    const found = await new HelpTranslationRepo(this.deps.db).findWithReviewer(workspaceId, article.id, locale);
    const row = found?.row;
    const proposalId =
      source !== undefined && row?.proposalSourceHash === source.contentHash ? row.proposalRevisionId : null;
    const ids = [row?.revisionId ?? null, proposalId].flatMap(id => (id === null ? [] : [id]));
    const rows = await articleRepo.revisionsByIds(ids);
    const revisions = new Map(rows.map(revision => [revision.id, revision]));
    const current = revisions.get(row?.revisionId ?? '');
    const proposal = revisions.get(proposalId ?? '');
    const madeFrom = row?.sourceHash ?? null;
    const isStale = madeFrom !== null && source !== undefined && madeFrom !== source.contentHash;
    const before = isStale
      ? await articleRepo.findByContentHash(workspaceId, article.id, source.locale, madeFrom)
      : undefined;
    const isReviewed = row?.state === TranslationStates.reviewed && current?.kind === RevisionKinds.humanEdit;
    return {
      locale,
      state: row?.state ?? null,
      isStale,
      lastError: row?.lastError ?? null,
      source: textOf(source),
      text: textOf(current),
      /** What the current text is: `machine`, or a person's `human_edit`. */
      textKind: current?.kind ?? null,
      reviewedBy: isReviewed ? (found?.reviewer ?? null) : null,
      reviewedAt: isReviewed ? current.createdAt : null,
      proposal:
        proposal === undefined ? null : { revisionId: proposal.id, title: proposal.title, body: proposal.bodyMd },
      /** Null when the text follows the source, or the source it was made from isn't kept. */
      changes:
        before === undefined || source === undefined ? null : segmentDiff(segmentsOf(before), segmentsOf(source)),
    };
  }
}
