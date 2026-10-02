// Help center (#96): a project's help site, written in Markdown as collections →
// sections → articles, with revision history, served publicly per locale. Translation,
// search and custom domains come in later slices; the data model already keys revisions
// by locale.
import { z } from 'zod';

/** Languages a help site can be written or translated in (BCP 47). */
export const HELP_LOCALES = ['en', 'ko', 'ja', 'zh', 'th', 'vi', 'id', 'es', 'pt', 'fr', 'de', 'it'] as const;
export type HelpLocale = (typeof HELP_LOCALES)[number];
export const helpLocaleSchema = z.enum(HELP_LOCALES);

export const ArticleStatuses = { draft: 'draft', published: 'published', archived: 'archived' } as const;
export type ArticleStatus = (typeof ArticleStatuses)[keyof typeof ArticleStatuses];

/** How a revision came to be. Translations (later) add `machine` and `human_edit`. */
export const RevisionKinds = { sourceEdit: 'source_edit', restore: 'restore', import: 'import' } as const;
export type RevisionKind = (typeof RevisionKinds)[keyof typeof RevisionKinds];

export const HelpLimits = {
  titleMax: 200,
  descriptionMax: 500,
  bodyMax: 200_000,
  slugMax: 80,
  pathMax: 300,
} as const;

/** A URL label: lowercase letters, digits and inner hyphens. */
export const helpSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u, 'Use lowercase letters, digits and hyphens')
  .max(HelpLimits.slugMax);

const titleSchema = z.string().trim().min(1).max(HelpLimits.titleMax);

export const helpSiteInputSchema = z
  .object({
    slug: helpSlugSchema,
    sourceLocale: helpLocaleSchema,
    locales: z.array(helpLocaleSchema).max(HELP_LOCALES.length),
  })
  .refine(input => !input.locales.includes(input.sourceLocale), {
    message: 'The source language is not one of the translations',
    path: ['locales'],
  });
export type HelpSiteInput = z.infer<typeof helpSiteInputSchema>;

export const collectionInputSchema = z.object({
  title: titleSchema,
  slug: helpSlugSchema,
  description: z.string().trim().max(HelpLimits.descriptionMax).optional(),
});
export type CollectionInput = z.infer<typeof collectionInputSchema>;

export const sectionInputSchema = z.object({ collectionId: z.uuid(), title: titleSchema });
export type SectionInput = z.infer<typeof sectionInputSchema>;

export const articleCreateInputSchema = z.object({
  sectionId: z.uuid(),
  title: titleSchema,
  slug: helpSlugSchema.optional(),
});
export type ArticleCreateInput = z.infer<typeof articleCreateInputSchema>;

export const draftInputSchema = z.object({
  articleId: z.uuid(),
  title: titleSchema,
  body: z.string().max(HelpLimits.bodyMax),
});
export type DraftInput = z.infer<typeof draftInputSchema>;

/** Turn a title into a URL label (ASCII only; a title without ASCII letters gets `article`). */
export function slugify(title: string): string {
  /* eslint-disable sonarjs/null-dereference -- title and the words are strings, never null */
  const words = title
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]/u)
    .filter(word => word !== '');
  let slug = '';
  // eslint-disable-next-line no-restricted-syntax -- stop at the length limit
  for (const word of words) {
    const next = slug === '' ? word : `${slug}-${word}`;
    if (next.length > HelpLimits.slugMax) {
      break;
    }
    slug = next;
  }
  /* eslint-enable sonarjs/null-dereference */
  return slug === '' ? 'article' : slug;
}

/** An article's public path: `/{locale}/articles/{shortId}-{slug}`. The slug is cosmetic. */
export function articlePath(locale: string, shortId: string, slug: string): string {
  return `/${locale}/articles/${shortId}-${slug}`;
}
