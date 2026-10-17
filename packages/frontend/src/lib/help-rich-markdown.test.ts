import { segmentMarkdown } from '@mocco/backend/helpcenter/segment';
import { describe, expect, it } from 'vitest';

import { encodeMarkdownText, roundTripHelpMarkdown } from '@frontend/lib/help-rich-markdown';

// What imported help articles look like: headings straight above lists, `>` as "then" in
// menu paths, bracketed labels, underscore emphasis, three-space list continuations, bare
// URLs and emails, images, a table, a quote and a code block.
const ARTICLE = `Learn how to set up the app the way you like it.

## Basic settings

### Stamp style
- **Style**: pick one of the stamp designs
- **Color**: Settings > Stamp > Color
- _Set the position and font freely_

### Q. [Android] The store says the app isn't compatible
1. **Open the gallery**: tap the thumbnail
   ![Camera thumbnail button](https://help.example.app/images/thumb.png)
2. **Pick a photo**: tap Import

Contact us at help@example.app or https://example.app/support.

> Tip: hold the shutter to shoot continuously.

| Plan | Ratio |
| --- | --- |
| Free | 1:1 |
| Pro | 4:3 |

\`\`\`sh
open "settings://camera" > log.txt
\`\`\`
`;

const hashes = (markdown: string) => segmentMarkdown(markdown).map(segment => segment.hash);

describe('help article Markdown in the rich editor', () => {
  it('keeps every translation segment through a round trip', () => {
    expect(hashes(roundTripHelpMarkdown(ARTICLE))).toEqual(hashes(ARTICLE));
  });

  it('settles: saving again keeps the segments, and changes nothing after the second save', () => {
    // A list item's continuation line (the image under "Open the gallery") loses its indent on
    // the first save and one more space on the second. CommonMark reads it as the same
    // paragraph either way (a lazy continuation), so only whitespace moves.
    const once = roundTripHelpMarkdown(ARTICLE);
    const twice = roundTripHelpMarkdown(once);
    expect(hashes(twice)).toEqual(hashes(ARTICLE));
    expect(roundTripHelpMarkdown(twice)).toBe(twice);
  });

  it('writes menu paths and bracketed labels as they were typed', () => {
    const out = roundTripHelpMarkdown(ARTICLE);
    expect(out).toContain('Settings > Stamp > Color');
    expect(out).toContain('### Q. [Android] The store says');
    expect(out).toContain('open "settings://camera" > log.txt');
    expect(out).not.toContain('&gt;');
  });

  it('escapes only what would change the meaning', () => {
    expect(encodeMarkdownText('A > B [label] 5 * 3')).toBe(String.raw`A > B [label] 5 \* 3`);
    expect(encodeMarkdownText('[not a link](really)')).toBe(String.raw`\[not a link\](really)`);
    expect(encodeMarkdownText('> not a quote')).toBe('&gt; not a quote');
    expect(encodeMarkdownText('a <b> tag & &amp; entity')).toBe('a &lt;b> tag & &amp;amp; entity');
    expect(encodeMarkdownText(String.raw`snake_case and C:\path`)).toBe(String.raw`snake\_case and C:\\path`);
  });
});
