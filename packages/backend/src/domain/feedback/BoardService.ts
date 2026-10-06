// A project's feedback boards and their categories (#172).
import { AuditActions } from '@mocco/common/audit';

import {
  FeedbackBoardNotFoundError,
  FeedbackCategoryNotFoundError,
  FeedbackSlugTakenError,
} from '@backend/domain/feedback/errors';
import { FeedbackBoardRepo } from '@backend/domain/feedback/repos/board.repo';
import { FeedbackCategoryRepo } from '@backend/domain/feedback/repos/category.repo';
import { FeedbackPostRepo } from '@backend/domain/feedback/repos/post.repo';
import { UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { FeedbackBoardRow } from '@backend/domain/feedback/repos/board.repo';
import type { FeedbackCategoryRow } from '@backend/domain/feedback/repos/category.repo';
import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';
import type { FeedbackBoardInput, FeedbackCategoryInput } from '@mocco/common/feedback';

export interface BoardServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'record'>;
}

const SLUG_CONSTRAINTS = {
  board: 'mocco_feedback_boards_project_slug_uq',
  category: 'mocco_feedback_categories_board_slug_uq',
} as const;

/** Map the slug's unique index to the domain error; rethrow anything else. */
async function slugChecked<T>(kind: keyof typeof SLUG_CONSTRAINTS, slug: string, write: () => Promise<T>) {
  try {
    return await write();
  } catch (error) {
    if (error instanceof UniqueConstraintError && error.constraint === SLUG_CONSTRAINTS[kind]) {
      throw new FeedbackSlugTakenError(kind, slug, { cause: error });
    }
    throw error;
  }
}

export class BoardService {
  constructor(private readonly deps: BoardServiceDeps) {}

  async listBoards(scope: FeedbackScope): Promise<FeedbackBoardRow[]> {
    return await new FeedbackBoardRepo(this.deps.db).list(scope);
  }

  /** The board, or FeedbackBoardNotFoundError. */
  async requireBoard(scope: FeedbackScope, boardId: string): Promise<FeedbackBoardRow> {
    const board = await new FeedbackBoardRepo(this.deps.db).find(scope, boardId);
    if (board === undefined) {
      throw new FeedbackBoardNotFoundError(boardId);
    }
    return board;
  }

  /** The category, which must be on `boardId`, or FeedbackCategoryNotFoundError. */
  async requireCategory(scope: FeedbackScope, boardId: string, categoryId: string): Promise<FeedbackCategoryRow> {
    const category = await new FeedbackCategoryRepo(this.deps.db).find(scope, categoryId);
    if (category?.boardId !== boardId) {
      throw new FeedbackCategoryNotFoundError(categoryId);
    }
    return category;
  }

  /** The board with its categories in order. */
  async getBoard(scope: FeedbackScope, boardId: string) {
    const board = await this.requireBoard(scope, boardId);
    const categories = await new FeedbackCategoryRepo(this.deps.db).listForBoard(scope, boardId);
    return { board, categories };
  }

  async createBoard(scope: FeedbackScope, actorUserId: string, input: FeedbackBoardInput): Promise<FeedbackBoardRow> {
    const board = await slugChecked(
      'board',
      input.slug,
      async () =>
        await new FeedbackBoardRepo(this.deps.db).insert({
          ...scope,
          slug: input.slug,
          name: input.name,
          ...(input.isPublic !== undefined && { isPublic: input.isPublic }),
        }),
    );
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.feedbackBoardCreated,
      subjectType: 'feedback_board',
      subjectId: board.id,
      payload: { projectId: scope.projectId, slug: board.slug, name: board.name },
    });
    return board;
  }

  async updateBoard(scope: FeedbackScope, boardId: string, input: FeedbackBoardInput): Promise<FeedbackBoardRow> {
    const board = await slugChecked(
      'board',
      input.slug,
      async () =>
        await new FeedbackBoardRepo(this.deps.db).update(scope, boardId, {
          slug: input.slug,
          name: input.name,
          ...(input.isPublic !== undefined && { isPublic: input.isPublic }),
        }),
    );
    if (board === undefined) {
      throw new FeedbackBoardNotFoundError(boardId);
    }
    return board;
  }

  /** Delete the board with its categories, posts and their history. */
  async deleteBoard(scope: FeedbackScope, actorUserId: string, boardId: string): Promise<void> {
    const board = await this.requireBoard(scope, boardId);
    if (!(await new FeedbackBoardRepo(this.deps.db).delete(scope, boardId))) {
      throw new FeedbackBoardNotFoundError(boardId);
    }
    await this.deps.audit.record(scope.workspaceId, {
      actorUserId,
      action: AuditActions.feedbackBoardDeleted,
      subjectType: 'feedback_board',
      subjectId: boardId,
      payload: { projectId: scope.projectId, slug: board.slug, name: board.name },
    });
  }

  async createCategory(
    scope: FeedbackScope,
    boardId: string,
    input: FeedbackCategoryInput,
  ): Promise<FeedbackCategoryRow> {
    await this.requireBoard(scope, boardId);
    const categories = new FeedbackCategoryRepo(this.deps.db);
    return await slugChecked(
      'category',
      input.slug,
      async () =>
        await categories.insert({
          ...scope,
          boardId,
          slug: input.slug,
          name: input.name,
          position: input.position ?? (await categories.nextPosition(boardId)),
        }),
    );
  }

  async updateCategory(
    scope: FeedbackScope,
    categoryId: string,
    input: FeedbackCategoryInput,
  ): Promise<FeedbackCategoryRow> {
    const category = await slugChecked(
      'category',
      input.slug,
      async () =>
        await new FeedbackCategoryRepo(this.deps.db).update(scope, categoryId, {
          slug: input.slug,
          name: input.name,
          ...(input.position !== undefined && { position: input.position }),
        }),
    );
    if (category === undefined) {
      throw new FeedbackCategoryNotFoundError(categoryId);
    }
    return category;
  }

  /** Delete the category; its posts stay on the board, uncategorized. */
  async deleteCategory(scope: FeedbackScope, categoryId: string): Promise<void> {
    const isDeleted = await this.deps.db.transaction(async tx => {
      await new FeedbackPostRepo(tx).uncategorize(scope, categoryId);
      return await new FeedbackCategoryRepo(tx).delete(scope, categoryId);
    });
    if (!isDeleted) {
      throw new FeedbackCategoryNotFoundError(categoryId);
    }
  }
}
