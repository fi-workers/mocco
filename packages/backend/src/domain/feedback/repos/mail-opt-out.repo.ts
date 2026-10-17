import { and, eq } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { FeedbackScope } from '@backend/domain/feedback/scope';
import type { Db } from '@backend/infra/db/types';

const o = schema.feedbackMailOptOuts;
const { projects } = schema;

/** Data access for mocco_feedback_mail_opt_outs (#180): end users who stopped all feedback mail
 * from a project. Scoped by workspace and project. */
export class FeedbackMailOptOutRepo {
  constructor(private readonly db: Db) {}

  /** Stop all of the end user's feedback mail from the project. Idempotent. */
  async optOut(scope: FeedbackScope, endUserId: string): Promise<void> {
    await this.db
      .insert(o)
      .values({ workspaceId: scope.workspaceId, projectId: scope.projectId, endUserId })
      .onConflictDoNothing({ target: [o.projectId, o.endUserId] });
  }

  /** Turn the end user's feedback mail from the project back on. Idempotent. */
  async optIn(scope: FeedbackScope, endUserId: string): Promise<void> {
    await this.db
      .delete(o)
      .where(and(eq(o.workspaceId, scope.workspaceId), eq(o.projectId, scope.projectId), eq(o.endUserId, endUserId)));
  }

  async isOptedOut(scope: FeedbackScope, endUserId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: o.id })
      .from(o)
      .where(and(eq(o.workspaceId, scope.workspaceId), eq(o.projectId, scope.projectId), eq(o.endUserId, endUserId)))
      .limit(1);
    return row !== undefined;
  }

  /** The project's name, for the page a link opens; undefined when it is gone. */
  async findProjectName(scope: FeedbackScope): Promise<string | undefined> {
    const [row] = await this.db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
    return row?.name;
  }
}
