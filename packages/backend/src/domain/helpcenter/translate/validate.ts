// Checks that a translated article kept the source's Markdown structure: the same
// headings (by level), the same fenced code blocks byte for byte, and the same link and
// image targets. A translation can change words, never structure or where links go.

/* eslint-disable sonarjs/null-dereference -- every value here is text from a split or a regex match, never null */

const FENCE = /^```[\s\S]*?^```/gmu;
const LINK_TARGET = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;

const headingLevels = (markdown: string) =>
  markdown
    .replaceAll(FENCE, '')
    .split('\n')
    .flatMap(line => {
      const level = /^(#{1,6})\s/u.exec(line)?.[1]?.length;
      return level === undefined ? [] : [level];
    });

const fences = (markdown: string) => Array.from(markdown.matchAll(FENCE), match => match[0]);

const targets = (markdown: string) =>
  Array.from(markdown.replaceAll(FENCE, '').matchAll(LINK_TARGET), match => match[1] ?? '').toSorted((a, b) =>
    a.localeCompare(b),
  );

/** Why the translation changed the structure, or null when it kept it. */
export function structureProblem(source: string, translated: string): string | null {
  if (headingLevels(source).join(',') !== headingLevels(translated).join(',')) {
    return 'the headings changed';
  }
  if (fences(source).join('\n') !== fences(translated).join('\n')) {
    return 'a code block changed';
  }
  if (targets(source).join('\n') !== targets(translated).join('\n')) {
    return 'a link or image target changed';
  }
  return null;
}
