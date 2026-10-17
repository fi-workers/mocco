import { aliasedTable, and, asc, desc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';

import * as schema from '@backend/infra/db/schema';

import type { FeedbackPostRow } from '@backend/domain/feedback/repos/post.repo';
import type { Db } from '@backend/infra/db/types';

export type FeedbackPostEmbeddingRow = typeof schema.feedbackPostEmbeddings.$inferSelect;

const e = schema.feedbackPostEmbeddings;
const p = schema.feedbackPosts;
const own = aliasedTable(e, 'own');

/** The post's words as `content_hash` hashes them: the service hashes the same text (contentHashOf). */
const contentHash = sql`encode(sha256(convert_to(${p.title} || E'\\n\\n' || ${p.body}, 'UTF8')), 'hex')`;

/** Cosine similarity of an older post's vector and the post's own: both are unit length, so it is
 * their dot product. */
const similarity = sql<number>`(SELECT sum(x.a * x.b) FROM unnest(${e.embedding}, ${own.embedding}) AS x(a, b))::float8`;

/** Data access for mocco_feedback_post_embeddings, and the sweep's reads of the posts they belong to. */
export class FeedbackPostEmbeddingRepo {
  constructor(private readonly db: Db) {}

  /**
   * Live posts with no vector from `model` for their current words, across every workspace: the
   * ones the duplicate sweep hasn't compared yet first (they are about to be), then the oldest.
   */
  async due(model: string, limit: number): Promise<FeedbackPostRow[]> {
    const rows = await this.db
      .select({ post: p })
      .from(p)
      .leftJoin(e, eq(e.postId, p.id))
      .where(and(isNull(p.mergedIntoPostId), or(isNull(e.postId), ne(e.model, model), ne(e.contentHash, contentHash))))
      .orderBy(sql`${p.duplicatesCheckedAt} IS NULL DESC`, asc(p.createdAt), asc(p.id))
      .limit(limit);
    return rows.map(row => row.post);
  }

  /** Store vectors, replacing a post's earlier one. */
  async upsertMany(rows: readonly (typeof e.$inferInsert)[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(e)
      .values([...rows])
      .onConflictDoUpdate({
        target: e.postId,
        set: {
          model: sql`excluded.model`,
          dims: sql`excluded.dims`,
          embedding: sql`excluded.embedding`,
          contentHash: sql`excluded.content_hash`,
          createdAt: sql`excluded.created_at`,
        },
      });
  }

  async find(postId: string): Promise<FeedbackPostEmbeddingRow | undefined> {
    const [row] = await this.db.select().from(e).where(eq(e.postId, postId)).limit(1);
    return row;
  }

  /**
   * The older live posts of `post`'s board whose `model` vectors are closest to its own, at least
   * `minScore` alike, the closest first. Nothing when the post has no vector from `model`.
   */
  async nearestOlder(
    post: FeedbackPostRow,
    model: string,
    opts: { minScore: number; limit: number },
  ): Promise<{ post: FeedbackPostRow; score: number }[]> {
    return await this.db
      .select({ post: p, score: similarity })
      .from(own)
      .innerJoin(e, and(eq(e.model, own.model), eq(e.dims, own.dims), ne(e.postId, own.postId)))
      .innerJoin(p, eq(p.id, e.postId))
      .where(
        and(
          eq(own.postId, post.id),
          eq(own.model, model),
          eq(p.workspaceId, post.workspaceId),
          eq(p.projectId, post.projectId),
          eq(p.boardId, post.boardId),
          lt(p.number, post.number),
          isNull(p.mergedIntoPostId),
          sql`${similarity} >= ${opts.minScore}`,
        ),
      )
      .orderBy(desc(similarity), desc(p.voteCount))
      .limit(opts.limit);
  }
}
