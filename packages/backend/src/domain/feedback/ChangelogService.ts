// A board's changelog (#176): entries the team writes as drafts, schedules or publishes, each
// announcing the board's posts it shipped. A scheduled entry goes public when the publish job
// (`publishDue`) finds it due. Publishing, unpublishing and deleting are audited; editing isn't
// (an entry is content, like a help article). The public pages, RSS and /v1 read published
// entries only.
import { AuditActions } from '@mocco/common/audit';
import { ChangelogEntryStates } from '@mocco/common/feedback';

import {
  ChangelogEntryNotFoundError,
  ChangelogEntryStateError,
  ChangelogPostsInvalidError,
  ChangelogPublishAtPastError,
  FeedbackSlugTakenError,
} from '@backend/domain/feedback/errors';
import { ChangelogEntryRepo } from '@backend/domain/feedback/repos/changelog-entry.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { BoardService } from '@backend/domain/feedback/BoardService';
import type { ChangelogEntryRow } from '@backend/domain/feedback/repos/changelog-entry.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type {
  ChangelogEntryCreateInput,
  ChangelogEntryListQuery,
  ChangelogEntryUpdateInput,
} from '@mocco/common/feedback';

export interface ChangelogServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
  boards: Pick<BoardService, 'requireBoard'>;
  now?: () => Date;
}

/** An entry with the posts it announces, in its order. */
export type ChangelogEntry = ChangelogEntryRow & { postIds: string[] };

/** How many due entries one run of the publish job publishes. */
export const CHANGELOG_PUBLISH_BATCH = 100;

const SLUG_CONSTRAINT = 'mocco_changelog_entries_board_slug_uq';

/** An address from a title: `Dark mode is here!` → `dark-mode-is-here`; '' when nothing is left. */
export function changelogSlugOf(title: string): string {
  /* eslint-disable sonarjs/null-dereference -- title and slug are strings, never null */
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(word => word !== '');
  let slug = words.join('-').slice(0, 80);
  while (slug.endsWith('-')) {
    slug = slug.slice(0, -1);
  }
  /* eslint-enable sonarjs/null-dereference */
  return slug;
}

/** `base`, or `base-2`, `base-3`… whichever the board doesn't have yet. */
function freeSlug(base: string, taken: readonly string[]): string {
  // eslint-disable-next-line sonarjs/null-dereference -- base is a string, never null
  const numbered = (n: number) => `${base.slice(0, 80 - String(n).length - 1)}-${String(n)}`;
  const used = new Set(taken);
  if (!used.has(base)) {
    return base;
  }
  let n = 2;
  while (used.has(numbered(n))) {
    n++;
  }
  return numbered(n);
}

/** Map the slug's unique index to the domain error; rethrow anything else. */
async function slugChecked<T>(slug: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof UniqueConstraintError && error.constraint === SLUG_CONSTRAINT) {
      throw new FeedbackSlugTakenError('changelog entry', slug, { cause: error });
    }
    throw error;
  }
}

/** The posts, deduplicated in order, after checking each is a live post of the board. */
async function checkedPosts(db: Db, scope: FeedbackScope, boardId: string, postIds: readonly string[]) {
  const unique = [...new Set(postIds)];
  const live = await new FeedbackPostRepo(db).liveIdsOnBoard(scope, boardId, unique);
  const invalid = unique.filter(id => !live.has(id));
  if (invalid.length > 0) {
    throw new ChangelogPostsInvalidError(invalid);
  }
  return unique;
}

export class ChangelogService {
  constructor(private readonly deps: ChangelogServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private async withPosts(rows: readonly ChangelogEntryRow[]): Promise<ChangelogEntry[]> {
    const postIds = await new ChangelogEntryRepo(this.deps.db).postIdsOf(rows.map(row => row.id));
    return rows.map(row => ({ ...row, postIds: postIds.get(row.id) ?? [] }));
  }

  private async transition(
    scope: FeedbackScope,
    entryId: string,
    action: 'publish' | 'schedule' | 'unpublish',
    next: (current: ChangelogEntryRow) => Pick<ChangelogEntryRow, 'state' | 'publishAt' | 'publishedAt'>,
  ): Promise<ChangelogEntry> {
    return await this.deps.db.transaction(async tx => {
      const repo = new ChangelogEntryRepo(tx);
      const current = await repo.findForUpdate(scope, entryId);
      if (current === undefined) {
        throw new ChangelogEntryNotFoundError(entryId);
      }
      const row = await repo.update(scope, entryId, next(current));
      if (row === undefined) {
        throw new ChangelogEntryStateError(current.state, action);
      }
      const [entry] = await new ChangelogService({ ...this.deps, db: tx }).withPosts([row]);
      return entry ?? { ...row, postIds: [] };
    });
  }

  private async audit(
    workspaceId: string,
    actorUserId: string | null,
    action:
      | typeof AuditActions.changelogEntryPublished
      | typeof AuditActions.changelogEntryUnpublished
      | typeof AuditActions.changelogEntryDeleted,
    entry: ChangelogEntry,
  ): Promise<void> {
    await this.deps.audit.record(workspaceId, {
      actorUserId,
      action,
      subjectType: 'changelog_entry',
      subjectId: entry.id,
      payload: { boardId: entry.boardId, slug: entry.slug, title: entry.title },
    });
  }

  /** The entry, or ChangelogEntryNotFoundError (also for another project's). */
  async get(scope: FeedbackScope, entryId: string): Promise<ChangelogEntry> {
    const row = await new ChangelogEntryRepo(this.deps.db).find(scope, entryId);
    if (row === undefined) {
      throw new ChangelogEntryNotFoundError(entryId);
    }
    const [entry] = await this.withPosts([row]);
    return entry ?? { ...row, postIds: [] };
  }

  /** A board's entries, newest first; another project's board is FeedbackBoardNotFoundError. */
  async list(scope: FeedbackScope, query: ChangelogEntryListQuery): Promise<ChangelogEntry[]> {
    await this.deps.boards.requireBoard(scope, query.boardId);
    return await this.withPosts(await new ChangelogEntryRepo(this.deps.db).list(scope, query));
  }

  /** A new draft on the board. Without a slug, one is made from the title (or the date) and kept free. */
  async create(scope: FeedbackScope, actorUserId: string, input: ChangelogEntryCreateInput): Promise<ChangelogEntry> {
    await this.deps.boards.requireBoard(scope, input.boardId);
    const entry = await this.deps.db.transaction(async tx => {
      const repo = new ChangelogEntryRepo(tx);
      const postIds = await checkedPosts(tx, scope, input.boardId, input.postIds ?? []);
      const base = changelogSlugOf(input.title) || this.now().toISOString().slice(0, 10);
      const slug = input.slug ?? freeSlug(base, await repo.slugsLike(input.boardId, base));
      const row = await slugChecked(
        slug,
        async () =>
          await repo.insert({
            ...scope,
            boardId: input.boardId,
            slug,
            title: input.title,
            bodyMd: input.body ?? '',
            tags: input.tags === undefined ? [] : [...new Set(input.tags)],
            createdByUserId: actorUserId,
          }),
      );
      await repo.replacePosts(scope.workspaceId, row.id, postIds);
      return { ...row, postIds };
    });
    return entry;
  }

  /** Edit the entry in any state; a published entry changes where it is shown. */
  async update(scope: FeedbackScope, entryId: string, input: ChangelogEntryUpdateInput): Promise<ChangelogEntry> {
    return await this.deps.db.transaction(async tx => {
      const repo = new ChangelogEntryRepo(tx);
      const current = await repo.findForUpdate(scope, entryId);
      if (current === undefined) {
        throw new ChangelogEntryNotFoundError(entryId);
      }
      const postIds =
        input.postIds === undefined ? undefined : await checkedPosts(tx, scope, current.boardId, input.postIds);
      const slug = input.slug ?? current.slug;
      const row = await slugChecked(
        slug,
        async () =>
          await repo.update(scope, entryId, {
            ...(input.title !== undefined && { title: input.title }),
            ...(input.body !== undefined && { bodyMd: input.body }),
            ...(input.slug !== undefined && { slug: input.slug }),
            ...(input.tags !== undefined && { tags: [...new Set(input.tags)] }),
          }),
      );
      if (postIds !== undefined) {
        await repo.replacePosts(scope.workspaceId, entryId, postIds);
      }
      const [entry] = await new ChangelogService({ ...this.deps, db: tx }).withPosts([row ?? current]);
      return entry ?? { ...current, postIds: [] };
    });
  }

  /** Publish the draft or scheduled entry now. */
  async publish(scope: FeedbackScope, actorUserId: string, entryId: string): Promise<ChangelogEntry> {
    const published = await this.transition(scope, entryId, 'publish', current => {
      if (current.state === ChangelogEntryStates.published) {
        throw new ChangelogEntryStateError(current.state, 'publish');
      }
      return { state: ChangelogEntryStates.published, publishAt: null, publishedAt: this.now() };
    });
    await this.audit(scope.workspaceId, actorUserId, AuditActions.changelogEntryPublished, published);
    return published;
  }

  /** Publish the draft (or move the scheduled entry) at `publishAt`, which must be ahead. */
  async schedule(scope: FeedbackScope, entryId: string, publishAt: Date): Promise<ChangelogEntry> {
    if (publishAt.getTime() <= this.now().getTime()) {
      throw new ChangelogPublishAtPastError();
    }
    return await this.transition(scope, entryId, 'schedule', current => {
      if (current.state === ChangelogEntryStates.published) {
        throw new ChangelogEntryStateError(current.state, 'schedule');
      }
      return { state: ChangelogEntryStates.scheduled, publishAt, publishedAt: null };
    });
  }

  /** Take a published or scheduled entry back to a draft (off the public pages). */
  async unpublish(scope: FeedbackScope, actorUserId: string, entryId: string): Promise<ChangelogEntry> {
    let wasPublished = false;
    const draft = await this.transition(scope, entryId, 'unpublish', current => {
      if (current.state === ChangelogEntryStates.draft) {
        throw new ChangelogEntryStateError(current.state, 'unpublish');
      }
      wasPublished = current.state === ChangelogEntryStates.published;
      return { state: ChangelogEntryStates.draft, publishAt: null, publishedAt: null };
    });
    if (wasPublished) {
      await this.audit(scope.workspaceId, actorUserId, AuditActions.changelogEntryUnpublished, draft);
    }
    return draft;
  }

  async delete(scope: FeedbackScope, actorUserId: string, entryId: string): Promise<void> {
    const entry = await this.get(scope, entryId);
    if (!(await new ChangelogEntryRepo(this.deps.db).delete(scope, entryId))) {
      throw new ChangelogEntryNotFoundError(entryId);
    }
    await this.audit(scope.workspaceId, actorUserId, AuditActions.changelogEntryDeleted, entry);
  }

  /**
   * The publish job: publish every scheduled entry whose time has come, as of its scheduled time,
   * up to CHANGELOG_PUBLISH_BATCH a run. Entries another run holds are skipped, so two runs never
   * publish one twice. Returns how many it published.
   */
  async publishDue(): Promise<number> {
    const published = await this.deps.db.transaction(async tx => {
      const repo = new ChangelogEntryRepo(tx);
      const due = await repo.lockDue(this.now(), CHANGELOG_PUBLISH_BATCH);
      const rows: ChangelogEntryRow[] = [];
      // eslint-disable-next-line no-restricted-syntax -- one update per locked row, in the same transaction
      for (const entry of due) {
        const scope = { workspaceId: entry.workspaceId, projectId: entry.projectId };
        // eslint-disable-next-line no-await-in-loop -- see above
        const row = await repo.update(scope, entry.id, {
          state: ChangelogEntryStates.published,
          publishAt: null,
          publishedAt: entry.publishAt ?? this.now(),
        });
        if (row !== undefined) {
          rows.push(row);
        }
      }
      return rows;
    });
    await Promise.all(
      published.map(
        async row =>
          await this.audit(row.workspaceId, null, AuditActions.changelogEntryPublished, { ...row, postIds: [] }),
      ),
    );
    return published.length;
  }
}
