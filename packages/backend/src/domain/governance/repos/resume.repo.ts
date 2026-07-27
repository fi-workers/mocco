import { and, asc, eq } from 'drizzle-orm';

import { expectOne } from '@backend/infra/db/rows';
import * as schema from '@backend/infra/db/schema';

import type { Db } from '@backend/infra/db/types';

/** A vote joined with the name of the role it counted under (null if that role was
 * later deleted, or the vote's role_id is null) — the wire shape the gate card reads. */
type ResumeWithRoleName = typeof schema.resumes.$inferSelect & { roleName: string | null };

/** Data access for mocco_resumes — the votes cast on a run's gates. One vote per
 * (gate, user) by DB unique constraint. Reads are scoped by `workspace_id`. */
export class ResumeRepo {
  constructor(private readonly db: Db) {}

  /** Record a vote and return the created row. The unique (run_gate_id, user_id)
   * constraint backstops a double vote — the service checks first and maps it to a
   * domain error, so a raced insert surfaces as a plain constraint error here. */
  async insert(row: typeof schema.resumes.$inferInsert) {
    return expectOne(await this.db.insert(schema.resumes).values(row).returning());
  }

  /** A single user's vote on a gate, or undefined — the duplicate-vote guard. */
  async findByGateAndUser(workspaceId: string, runGateId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(schema.resumes)
      .where(
        and(
          eq(schema.resumes.workspaceId, workspaceId),
          eq(schema.resumes.runGateId, runGateId),
          eq(schema.resumes.userId, userId),
        ),
      );
    return row;
  }

  /** All votes on a gate, oldest-first — the evaluator input and the card's progress. */
  async listByRunGate(workspaceId: string, runGateId: string) {
    return await this.db
      .select()
      .from(schema.resumes)
      .where(and(eq(schema.resumes.workspaceId, workspaceId), eq(schema.resumes.runGateId, runGateId)))
      .orderBy(asc(schema.resumes.createdAt));
  }

  /** All votes across a run's gates, each with its role name — the run-detail read
   * groups them by gate for the card's per-role progress. Left-joined so a vote whose
   * role was deleted still appears (roleName null). */
  async listByRun(workspaceId: string, runId: string): Promise<ResumeWithRoleName[]> {
    const rows = await this.db
      .select({ resume: schema.resumes, roleName: schema.roles.name })
      .from(schema.resumes)
      .leftJoin(schema.roles, eq(schema.resumes.roleId, schema.roles.id))
      .where(and(eq(schema.resumes.workspaceId, workspaceId), eq(schema.resumes.runId, runId)))
      .orderBy(asc(schema.resumes.createdAt));
    return rows.map(row => ({ ...row.resume, roleName: row.roleName }));
  }
}
