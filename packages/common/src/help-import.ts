// Importing a help site from Mintlify (#96): docs.json's navigation (tabs → groups →
// pages) becomes collections → sections → articles, and each page's MDX becomes the
// plain Markdown Mocco stores. Pure, so the console can convert a picked folder in the
// browser and the backend can validate what arrives.
import { z } from 'zod';

import { HelpLimits, helpSlugSchema } from './help';

/* eslint-disable sonarjs/null-dereference -- every value here is text from a regex callback or a split, never null */

export const importArticleSchema = z.object({
  title: z.string().trim().min(1).max(HelpLimits.titleMax),
  slug: helpSlugSchema,
  body: z.string().max(HelpLimits.bodyMax),
  /** The page's path on the old site, kept as a redirect. */
  fromPath: z.string().startsWith('/').max(HelpLimits.pathMax),
});

export const importBundleSchema = z.object({
  collections: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(HelpLimits.titleMax),
        slug: helpSlugSchema,
        sections: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(HelpLimits.titleMax),
              articles: z.array(importArticleSchema).max(500),
            }),
          )
          .max(100),
      }),
    )
    .min(1)
    .max(50),
});
export type ImportBundle = z.infer<typeof importBundleSchema>;

/** The parts of Mintlify's docs.json the import reads. */
export const mintlifyDocsSchema = z.object({
  navigation: z.object({
    tabs: z.array(
      z.object({
        tab: z.string(),
        groups: z.array(z.object({ group: z.string(), pages: z.array(z.string()) })),
      }),
    ),
  }),
});
export type MintlifyDocs = z.infer<typeof mintlifyDocsSchema>;

/** The `title` from MDX frontmatter (quoted or bare) and the body after it. */
export function splitMdxFrontmatter(source: string): { title: string | null; body: string } {
  const normalized = source.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) {
    return { title: null, body: normalized };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    return { title: null, body: normalized };
  }
  const front = normalized.slice(4, end);
  const titleLine = front.split('\n').find(line => line.startsWith('title:'));
  const raw = titleLine?.slice('title:'.length).trim() ?? '';
  const title = raw.replace(/^(['"])(.*)\1$/u, '$2');
  return { title: title === '' ? null : title, body: normalized.slice(end + 4).replace(/^\n+/u, '') };
}

const CALLOUTS: Record<string, string> = { Tip: 'Tip', Info: 'Note', Note: 'Note', Warning: 'Warning', Check: 'Done' };

/** A block as a Markdown blockquote with a bold label. */
function asCallout(label: string, inner: string): string {
  const lines = inner.trim().split('\n');
  return [`> **${label}:** ${lines[0] ?? ''}`, ...lines.slice(1).map(line => (line === '' ? '>' : `> ${line}`))].join(
    '\n',
  );
}

/** Indent every line but blank ones. */
const indent = (text: string, by: string) =>
  text
    .split('\n')
    .map(line => (line === '' ? '' : `${by}${line}`))
    .join('\n');

/** The attribute `name="value"` of a JSX tag's attribute string. */
function attribute(attributes: string, name: string): string {
  return new RegExp(String.raw`\b${name}="([^"]*)"`, 'u').exec(attributes)?.[1] ?? '';
}

/** One callout tag on a line of its own (`<Tip>`), possibly indented. */
const CALLOUT_OPEN = /^([ \t]*)<(Tip|Info|Note|Warning|Check)>(.*)$/u;

/**
 * A callout's body lines, from the opening line's remainder (`after`) to the line holding
 * `close`, dedented by `lead`; and the index of the line after it.
 */
function readCallout(
  lines: readonly string[],
  start: number,
  opening: { lead: string; close: string; after: string },
): { inner: string[]; next: number } {
  const { lead, close, after } = opening;
  if (after.includes(close)) {
    return { inner: [after.slice(0, after.indexOf(close))], next: start + 1 };
  }
  const inner = after.trim() === '' ? [] : [after];
  let index = start + 1;
  while (index < lines.length && !(lines[index] ?? '').includes(close)) {
    const body = lines[index] ?? '';
    inner.push(body.startsWith(lead) ? body.slice(lead.length) : body);
    index += 1;
  }
  const last = lines[index] ?? '';
  const before = last.slice(0, last.indexOf(close)).trim();
  return { inner: before === '' ? inner : [...inner, before], next: index + 1 };
}

/**
 * Callouts → labelled quotes, line by line: from a line opening one (`<Tip>`) to the line
 * closing it, kept at the opening line's indentation (inside a step, say).
 */
function convertCallouts(text: string): string {
  const out: string[] = [];
  const lines = text.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const open = CALLOUT_OPEN.exec(line);
    if (open === null) {
      out.push(line);
      index += 1;
    } else {
      const [, lead = '', name = '', after = ''] = open;
      const { inner, next } = readCallout(lines, index, { lead, close: `</${name}>`, after });
      out.push(indent(asCallout(CALLOUTS[name] ?? name, inner.join('\n')), lead));
      index = next;
    }
  }
  return out.join('\n');
}

/**
 * Mintlify MDX → Markdown: `<Steps>`/`<Step title>` → a numbered list with bold titles,
 * `<Tip>`/`<Info>`/`<Note>`/`<Warning>`/`<Check>` → labelled blockquotes, `<Update label
 * description>` → a `##` heading per update, any other component tag dropped (its
 * content kept). Image paths go through `image`.
 */
export function mintlifyToMarkdown(mdx: string, image: (path: string) => string = path => path): string {
  let text = mdx.replaceAll('\r\n', '\n');
  // Steps first: their bodies may hold callouts, which are converted after indenting.
  text = text.replaceAll(/<Steps>\n?([\s\S]*?)<\/Steps>/gu, (_all, inner: string) => {
    // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray isn't in every browser the console supports
    const steps = [...inner.matchAll(/<Step([^>]*)>([\s\S]*?)<\/Step>/gu)];
    return steps
      .map((step, index) => {
        const title = attribute(step[1] ?? '', 'title');
        const body = (step[2] ?? '').trim();
        const head = `${index + 1}. **${title}**`;
        return body === '' ? head : `${head}\n\n${indent(body, ' '.repeat(3))}`;
      })
      .join('\n\n');
  });
  text = text.replaceAll(/<Update([^>]*)>([\s\S]*?)<\/Update>/gu, (_all, attributes: string, inner: string) => {
    const label = attribute(attributes, 'label');
    const description = attribute(attributes, 'description');
    const body = inner
      .split('\n')
      .map(line => line.replace(/^ {2}/u, ''))
      .join('\n')
      .trim();
    const date = description === '' ? '' : ` (${description})`;
    return `## ${label}${date}\n\n${body}`;
  });
  text = convertCallouts(text);
  // Any other component: keep what's inside.
  text = text.replaceAll(/<\/?[A-Z][A-Za-z]*(?:\s[^>]*)?\/?>/gu, '');
  text = text.replaceAll(
    /!\[([^\]]*)\]\(([^)\s]+)\)/gu,
    (_all, alt: string, path: string) => `![${alt}](${image(path)})`,
  );
  return `${text.replaceAll(/\n{3,}/gu, '\n\n').trim()}\n`;
}

/** Image paths a converted page refers to that aren't absolute URLs. */
export function localImagePaths(markdown: string): string[] {
  return Array.from(markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/gu), match => match[1] ?? '').filter(
    path => path !== '' && !/^https?:\/\//u.test(path),
  );
}

/** The URL label of a page path: its last segment. */
const pageSlug = (page: string) => page.split('/').at(-1) ?? page;

/**
 * The import bundle for a Mintlify site: `pages` maps a page path (`features/widget`) to
 * its MDX. A collection's slug is its pages' shared folder (`features`), else `tab-<n>`.
 * Pages missing from `pages` are skipped.
 */
export function bundleFromMintlify(
  docs: MintlifyDocs,
  pages: ReadonlyMap<string, string>,
  image?: (path: string) => string,
): ImportBundle {
  return {
    collections: docs.navigation.tabs.map((tab, index) => {
      const folders = new Set(tab.groups.flatMap(group => group.pages.map(page => page.split('/', 1)[0] ?? '')));
      const [folder] = folders;
      return {
        title: tab.tab,
        slug: folders.size === 1 && folder !== undefined && /^[a-z0-9-]+$/u.test(folder) ? folder : `tab-${index + 1}`,
        sections: tab.groups.map(group => ({
          title: group.group,
          articles: group.pages.flatMap(page => {
            const source = pages.get(page);
            if (source === undefined) {
              return [];
            }
            const { title, body } = splitMdxFrontmatter(source);
            return [
              {
                title: title ?? pageSlug(page),
                slug: pageSlug(page)
                  .toLowerCase()
                  .replaceAll(/[^a-z0-9-]/gu, '-'),
                body: mintlifyToMarkdown(body, image),
                fromPath: `/${page}`,
              },
            ];
          }),
        })),
      };
    }),
  };
}
