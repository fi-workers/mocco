// The /v1/help wire shapes (#216): what an app reads from a project's published help
// center with a help:read key. The routes parse their answers through these, and the
// SDK's types are checked against them (sdk-contract.test.ts).
import { z } from 'zod';

/**
 * A reader's language as a device reports it (`en`, `en-KR`, `zh-Hant-TW`): its language
 * subtag, lowercased, is what the site serves when it offers it.
 */
export const helpV1LocaleSchema = z
  .string()
  .max(35)
  .regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/u)
  // eslint-disable-next-line sonarjs/null-dereference -- zod hands the transform a string
  .transform(tag => tag.split(/[-_]/u, 1)[0]?.toLowerCase() ?? '');

export const helpV1LocaleQuerySchema = z.object({ locale: helpV1LocaleSchema.optional() });

export const helpV1SearchQuerySchema = helpV1LocaleQuerySchema.extend({
  q: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(5),
  /** `any`: one word is enough, for free text such as an inquiry being written. */
  match: z.enum(['all', 'any']).default('all'),
});

/** `{shortId}` or `{shortId}-{slug}`, as an article's path carries it. */
export const helpV1ArticleRefSchema = z.string().regex(/^[a-z0-9]{6}(?:-[a-z0-9-]{0,80})?$/u);

const urlOrNull = z.string().nullable();

export const helpV1SearchResultSchema = z.object({
  locale: z.string(),
  hits: z.array(z.object({ title: z.string(), path: z.string(), url: urlOrNull, snippet: z.string() })),
});

/** An article in a listing: `id` is its stable short id (the slug is cosmetic). */
export const helpV1ArticleEntrySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  path: z.string(),
  url: urlOrNull,
});

export const helpV1CollectionSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  sections: z.array(z.object({ title: z.string(), articles: z.array(helpV1ArticleEntrySchema) })),
});

/** The help center: its name and languages, and what it publishes in `locale`. */
export const helpV1SiteSchema = z.object({
  name: z.string(),
  sourceLocale: z.string(),
  /** The languages it is translated into (the source not included). */
  locales: z.array(z.string()),
  /** The language served: the asked one when offered, else the source. */
  locale: z.string(),
  url: urlOrNull,
  collections: z.array(helpV1CollectionSchema),
});

export const helpV1CollectionResultSchema = z.object({ locale: z.string(), collection: helpV1CollectionSchema });

export const helpV1ArticleSchema = z.object({
  id: z.string(),
  slug: z.string(),
  /** The language served: a translation where there is one, else the source. */
  locale: z.string(),
  title: z.string(),
  /** Markdown. */
  body: z.string(),
  path: z.string(),
  url: urlOrNull,
  /** The languages this article is served in (the source first). */
  locales: z.array(z.string()),
  publishedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

/** The longest comment a "Was this helpful?" answer may carry. */
export const HELP_FEEDBACK_COMMENT_MAX = 500;

/**
 * "Was this helpful?" (`POST /v1/help/articles/:id/feedback`, and the public site's widget).
 * `visitorId` is an opaque id the client generates and keeps (the SDK and the site's widget
 * do); Mocco stores only a keyed hash of it. Without one, the network address and user
 * agent stand in, hashed with the day, so one answer per article per day is counted.
 */
export const helpV1FeedbackInputSchema = z.object({
  helpful: z.boolean(),
  locale: helpV1LocaleSchema.optional(),
  comment: z.string().trim().max(HELP_FEEDBACK_COMMENT_MAX).optional(),
  visitorId: z
    .string()
    .regex(/^[\w-]{8,64}$/u)
    .optional(),
});

export const helpV1FeedbackResultSchema = z.object({
  /** False when this visitor already answered today: the newer answer replaced the older one. */
  counted: z.boolean(),
});

/** An article's answers over the last `days` days (the console's article editor). */
export const helpfulnessSchema = z.object({
  days: z.number(),
  helpful: z.number(),
  notHelpful: z.number(),
  comments: z.array(z.object({ helpful: z.boolean(), comment: z.string(), locale: z.string(), createdAt: z.date() })),
});
export type Helpfulness = z.infer<typeof helpfulnessSchema>;
