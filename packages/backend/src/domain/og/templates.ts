// The OG image templates (ADR 0030): each is a version, a zod schema of its fields and a
// builder from those fields to an element tree. The schema validates what a page issues,
// and later drives the console form and the MCP tool. Bump a template's version when its
// look changes: the version is part of every image's signature, so old cards get new URLs.
// Layout follows the Kakao safe area — text stays clear of the left and right edges that
// a 2:1 crop cuts.
import { z } from 'zod';

import { box, text } from '@backend/domain/og/element';

import type { OgElement } from '@backend/domain/og/element';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const brandSchema = z.object({
  /** The site or product name shown at the top. */
  name: z.string().trim().min(1).max(60),
  /** A #rrggbb accent for the top rule and the eyebrow. */
  accent: z
    .string()
    .regex(/^#[0-9a-f]{6}$/iu)
    .optional(),
});

const INK = '#0a0a0a';
const MUTED = '#525252';
const PAPER = '#fafafa';
const DEFAULT_ACCENT = '#0a0a0a';

/** Long titles get a smaller size so they stay within three lines. */
const titleSize = (title: string) => {
  // eslint-disable-next-line sonarjs/null-dereference -- a parsed string, never null
  if (title.length > 70) {
    return 52;
  }
  return title.length > 40 ? 62 : 72;
};

function frame(brand: z.infer<typeof brandSchema>, ...children: OgElement[]): OgElement {
  const accent = brand.accent ?? DEFAULT_ACCENT;
  return box(
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: '64px 96px',
      backgroundColor: PAPER,
      borderTop: `12px solid ${accent}`,
      fontFamily: 'Pretendard',
      color: INK,
    },
    text({ fontSize: 34, fontWeight: 600, letterSpacing: '-0.01em' }, brand.name),
    ...children,
  );
}

const simpleFields = z.object({
  brand: brandSchema,
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(160).optional(),
});

const articleFields = z.object({
  brand: brandSchema,
  /** The collection or set the page sits in, shown above the title. */
  eyebrow: z.string().trim().max(60).optional(),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(200).optional(),
});

export const OgTemplates = {
  /** A title and an optional line under it: landing pages, product pages. */
  simple: {
    version: 1,
    fields: simpleFields,
    build: (fields: z.infer<typeof simpleFields>): OgElement =>
      frame(
        fields.brand,
        box(
          { flexDirection: 'column', gap: 20 },
          text(
            { fontSize: titleSize(fields.title), fontWeight: 600, lineHeight: 1.1, letterSpacing: '-0.03em' },
            fields.title,
          ),
          ...(fields.subtitle === undefined
            ? []
            : [text({ fontSize: 32, color: MUTED, lineHeight: 1.35 }, fields.subtitle)]),
        ),
        box({ height: 8 }),
      ),
  },
  /** A guide or help article: where it sits, its title and its opening line. */
  article: {
    version: 1,
    fields: articleFields,
    build: (fields: z.infer<typeof articleFields>): OgElement =>
      frame(
        fields.brand,
        box(
          { flexDirection: 'column', gap: 18 },
          ...(fields.eyebrow === undefined
            ? []
            : [text({ fontSize: 28, fontWeight: 600, color: fields.brand.accent ?? MUTED }, fields.eyebrow)]),
          text(
            { fontSize: titleSize(fields.title), fontWeight: 600, lineHeight: 1.12, letterSpacing: '-0.03em' },
            fields.title,
          ),
          ...(fields.description === undefined
            ? []
            : [
                text(
                  { fontSize: 30, color: MUTED, lineHeight: 1.4, maxHeight: 84, overflow: 'hidden' },
                  fields.description,
                ),
              ]),
        ),
        box({ height: 8 }),
      ),
  },
} as const;

export type OgTemplate = keyof typeof OgTemplates;
export const ogTemplateSchema = z.enum(Object.keys(OgTemplates) as [OgTemplate, ...OgTemplate[]]);
export type OgFields<T extends OgTemplate> = z.infer<(typeof OgTemplates)[T]['fields']>;
