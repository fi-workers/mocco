// The feedback domain's services over a db (#172). Pure (no instance imports); instance.ts binds
// the production deps, tests bind pglite.
import { BoardService } from '@backend/domain/feedback/BoardService';
import { PostService } from '@backend/domain/feedback/PostService';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { Db } from '@backend/infra/db/types';

export interface FeedbackDomain {
  feedbackBoards: BoardService;
  feedbackPosts: PostService;
}

export function createFeedbackDomain(
  db: Db,
  deps: { audit: Pick<AuditService, 'record'>; now?: () => Date },
): FeedbackDomain {
  const feedbackBoards = new BoardService({ db, audit: deps.audit });
  return {
    feedbackBoards,
    feedbackPosts: new PostService({
      db,
      audit: deps.audit,
      boards: feedbackBoards,
      ...(deps.now !== undefined && { now: deps.now }),
    }),
  };
}
