/* eslint-disable sonarjs/null-dereference -- segment texts and split parts are strings, never null */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { URL_LIKE } from '@backend/domain/helpcenter/markdown/protect';
import { reassemble, reassembleTitle } from '@backend/domain/helpcenter/markdown/reassemble';
import {
  segmentHash,
  segmentMarkdown,
  segmentRefsOf,
  segmentTitle,
  translatable,
} from '@backend/domain/helpcenter/markdown/segment';
import { corpus } from '@backend/domain/helpcenter/markdown/testing/corpus';
import { normalizeMarkdown } from '@backend/domain/helpcenter/markdown/tree';
import { segmentProblem, structureProblem } from '@backend/domain/helpcenter/markdown/validate';
import { TranslationRejectedError } from '@backend/domain/helpcenter/translate/Translator';

import type { Segment } from '@backend/domain/helpcenter/markdown/segment';

const byName = (a: string, b: string) => a.localeCompare(b);

const identity = (segments: readonly Segment[]) => new Map(segments.map(({ id, text }) => [id, text]));

/** A stand-in translator: uppercases the words, leaves every placeholder where it was. */
const shout = (segments: readonly Segment[]) =>
  new Map(
    segments.map(({ id, text }) => [
      id,
      text
        .split(/(⟦\/?\d+⟧)/u)
        .map((part, i) => (i % 2 === 0 ? part.toUpperCase() : part))
        .join(''),
    ]),
  );

const GOLDEN: Record<string, readonly (readonly [string, string])[]> = {
  'headings, emphasis and links with titles': [
    ['heading', 'Install the widget'],
    ['paragraph', 'Open ⟦0⟧Settings⟦/0⟧, then ⟦1⟧Widgets⟦/1⟧ and ⟦2⟧old⟦/2⟧ new ⟦3⟧the guide⟦/3⟧.'],
    ['linkTitle', 'Widget guide'],
    ['heading', 'Setext heading'],
    ['heading', 'Third ⟦0⟧level⟦/0⟧ heading'],
  ],
  'nested lists and task lists': [
    ['paragraph', 'First step'],
    ['paragraph', 'Sign in at ⟦0⟧.'],
    ['paragraph', 'Pick a project'],
    ['paragraph', 'Done item'],
    ['paragraph', 'Open item with ⟦0⟧'],
    ['paragraph', 'Second step'],
    ['paragraph', 'Ordered from three'],
    ['paragraph', 'Next'],
  ],
  'a table with inline code and links': [
    ['tableCell', 'Option'],
    ['tableCell', 'Default'],
    ['tableCell', 'Notes'],
    ['tableCell', 'See ⟦0⟧limits⟦/0⟧'],
    ['tableCell', 'Retries | pipes escaped'],
  ],
  'code fences with Markdown inside': [
    ['paragraph', 'Run this:'],
    ['paragraph', 'After the code.'],
  ],
  'images, asset refs and reference links': [
    ['imageAlt', 'The settings page'],
    ['linkTitle', 'Settings title'],
    ['paragraph', 'Inline ⟦0⟧ next to text, see ⟦1⟧ too.'],
    ['imageAlt', 'a diagram'],
    ['paragraph', 'Read the ⟦0⟧reference⟦/0⟧ and ⟦1⟧another one⟦/1⟧.'],
    ['linkTitle', 'Reference title'],
  ],
  'HTML blocks and inline HTML': [['paragraph', 'Inline ⟦0⟧Ctrl⟦1⟧+⟦2⟧K⟦3⟧ opens search.']],
  'Korean with variables, emoji and bare URLs': [
    ['heading', '위젯 설치하기'],
    ['paragraph', '안녕하세요, ⟦0⟧님! ⟦1⟧ 먼저 ⟦2⟧ 로그인하세요.'],
    ['paragraph', '⟦0⟧참고:⟦/0⟧ ⟦1⟧ 명령은 ⟦2⟧ 폴더에서 실행합니다.'],
    ['paragraph', '목록 항목 하나'],
    ['paragraph', '자세한 내용은 ⟦0⟧도움말⟦/0⟧을 보세요.'],
    ['linkTitle', '도움말 제목'],
  ],
  'Japanese with inline code, strong and links': [
    ['heading', 'ウィジェットの設定'],
    ['paragraph', '⟦0⟧重要:⟦/0⟧ 設定は⟦1⟧に保存されます。詳しくは⟦2⟧ガイド⟦/2⟧をご覧ください。'],
    ['paragraph', 'ダッシュボードを開く'],
    ['paragraph', '「保存」を押す — ⟦0⟧ を参照'],
    ['tableCell', '項目'],
    ['tableCell', '説明'],
    ['tableCell', '名前'],
    ['tableCell', 'プロジェクトの⟦0⟧名前⟦/0⟧'],
  ],
  'blockquotes, footnotes and breaks': [
    ['paragraph', 'Quoted paragraph with a footnote.⟦0⟧'],
    ['paragraph', 'Nested quote.'],
    ['paragraph', 'Line one with a hard break⟦0⟧line two after it⟦1⟧line three.'],
    ['paragraph', 'The footnote text, with a ⟦0⟧link⟦/0⟧.'],
  ],
  'escapes, look-alike placeholders and autolinks': [
    ['paragraph', String.raw`Literal *stars* and _underscores_ and a backslash \ here.`],
    ['paragraph', 'A fake placeholder ⟦0⟧0⟦1⟧ and ⟦2⟧/1⟦3⟧ written by the author.'],
    ['paragraph', 'Autolinks ⟦0⟧ and ⟦1⟧ and plain ⟦2⟧.'],
    ['paragraph', 'Entities & © and an ⟦0⟧HTML link⟦1⟧.'],
  ],
  'mixed scripts and glossary-free product names': [
    ['heading', 'Mocco Gate と 게이트'],
    ['paragraph', 'Mocco Gate는 ⟦0⟧ 前に承認を待ちます。Use ⟦1⟧Mocco Gate⟦/1⟧ to pause.'],
    ['paragraph', '한국어 ⟦0⟧기울임⟦/0⟧ and ⟦1⟧굵게⟦/1⟧'],
    ['paragraph', '日本語の⟦0⟧取り消し⟦/0⟧'],
  ],
};

describe('help center Markdown segmentation (golden corpus)', () => {
  it('covers every corpus document with a golden list', () => {
    expect(Object.keys(GOLDEN).toSorted(byName)).toEqual(corpus.map(doc => doc.name).toSorted(byName));
  });

  describe.each(corpus)('$name', doc => {
    const segments = segmentMarkdown(doc.markdown);

    it('segments as the golden list says', () => {
      expect(segments.map(({ kind, text }) => [kind, text])).toEqual(GOLDEN[doc.name]);
      expect(segments.map(({ id }) => id)).toEqual(segments.map((_, i) => `s${String(i)}`));
    });

    it('never shows the translator code, URLs, asset refs or variables', () => {
      const sent = JSON.stringify(translatable(segments));
      expect(doc.hidden.filter(hidden => sent.includes(hidden))).toEqual([]);
      expect(segments.filter(({ text }) => text.match(URL_LIKE) !== null || /\{\{|`/u.test(text))).toEqual([]);
    });

    it('round-trips an identity translation to the normalized source', () => {
      expect(reassemble(doc.markdown, identity(segments))).toBe(normalizeMarkdown(doc.markdown));
    });

    it('keeps the structure through a translation that changes every word', () => {
      const translated = reassemble(doc.markdown, shout(segments));
      expect(structureProblem(doc.markdown, translated)).toBeNull();
      expect(segmentMarkdown(translated).map(({ kind }) => kind)).toEqual(segments.map(({ kind }) => kind));
    });
  });

  it('protects glossary keep terms as written', () => {
    const [heading, paragraph] = segmentMarkdown('# Mocco Gate setup\n\nUse Mocco Gate, not mocco gate.', {
      keep: ['Mocco Gate'],
    });
    expect(heading?.text).toBe('⟦0⟧ setup');
    expect(paragraph?.text).toBe('Use ⟦0⟧, not mocco gate.');
  });

  it('skips text with nothing to translate', () => {
    expect(segmentMarkdown('![](asset://a.png)\n\n`code`\n\n2026\n\n---')).toEqual([]);
  });
});

describe('help center Markdown segment hashes', () => {
  it('hash the text, so an edit changes only its own segment', () => {
    const before = segmentRefsOf('Title', 'One paragraph.\n\nTwo paragraph.');
    const after = segmentRefsOf('Title', 'One paragraph.\n\nTwo paragraphs, edited.');
    expect(before.map(({ kind }) => kind)).toEqual(['title', 'paragraph', 'paragraph']);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual(before[1]);
    expect(after[2]?.hash).not.toBe(before[2]?.hash);
  });

  it('ignore whitespace and Unicode normalization differences', () => {
    expect(segmentHash('Café  au\nlait ')).toBe(segmentHash('Café au lait'));
  });

  it('name the protected text, not what the placeholders hold', () => {
    const [a] = segmentMarkdown('Read [this](https://a.test).');
    const [b] = segmentMarkdown('Read [this](https://b.test).');
    expect(a?.hash).toBe(b?.hash);
  });
});

describe('help center Markdown titles', () => {
  it('protect variables and restore them', () => {
    const segment = segmentTitle('Welcome, {{name}}');
    expect(segment.text).toBe('Welcome, ⟦0⟧');
    expect(reassembleTitle('Welcome, {{name}}', '환영합니다, ⟦0⟧')).toBe('환영합니다, {{name}}');
    expect(() => reassembleTitle('Welcome, {{name}}', '환영합니다')).toThrow(TranslationRejectedError);
  });
});

describe('help center Markdown validation', () => {
  const [segment] = segmentMarkdown('Open **Settings** and run `npm i` at https://a.test.');
  const source = segment ?? { text: '', slots: [] };

  it('the source shape', () => {
    expect(source.text).toBe('Open ⟦0⟧Settings⟦/0⟧ and run ⟦1⟧ at ⟦2⟧.');
  });

  it('accepts reordered placeholders and new words', () => {
    expect(segmentProblem(source, '⟦2⟧에서 ⟦1⟧을 실행하고 ⟦0⟧설정⟦/0⟧을 엽니다.')).toBeNull();
  });

  it.each([
    ['a dropped placeholder', 'Open ⟦0⟧Settings⟦/0⟧ and run at ⟦2⟧.', 'the placeholder ⟦1⟧ is missing'],
    ['a dropped closing placeholder', 'Open ⟦0⟧Settings and run ⟦1⟧ at ⟦2⟧.', 'the placeholder ⟦/0⟧ is missing'],
    ['a duplicated placeholder', 'Open ⟦0⟧Settings⟦/0⟧, run ⟦1⟧ and ⟦1⟧ at ⟦2⟧.', 'appears more than once'],
    ['an unknown placeholder', 'Open ⟦0⟧Settings⟦/0⟧ and run ⟦1⟧ at ⟦2⟧ ⟦7⟧.', 'unknown placeholder ⟦7⟧'],
    ['a closing atomic placeholder', 'Open ⟦0⟧Settings⟦/0⟧ and run ⟦1⟧⟦/1⟧ at ⟦2⟧.', 'unknown placeholder ⟦/1⟧'],
    ['a close before its open', 'Open ⟦/0⟧Settings⟦0⟧ and run ⟦1⟧ at ⟦2⟧.', 'closes out of order'],
    ['a stray bracket', 'Open ⟦0⟧Settings⟦/0⟧ and run ⟦1⟧ at ⟦2⟧ ⟦.', 'a stray placeholder bracket'],
    ['a new URL', 'Open ⟦0⟧Settings⟦/0⟧ and run ⟦1⟧ at ⟦2⟧ or https://evil.test.', 'a new link (https://evil.test)'],
    ['a new www link', 'Open ⟦0⟧Settings⟦/0⟧ and run ⟦1⟧ at ⟦2⟧ or www.evil.test.', 'a new link'],
    ['a new email', 'Open ⟦0⟧Settings⟦/0⟧ and run ⟦1⟧ at ⟦2⟧, mail spam@evil.test.', 'a new link'],
  ])('rejects %s', (_name, translated, problem) => {
    expect(segmentProblem(source, translated)).toContain(problem);
  });

  it('rejects overlapping wrappers', () => {
    const [nested] = segmentMarkdown('A **bold _both_** end.');
    expect(nested?.text).toBe('A ⟦0⟧bold ⟦1⟧both⟦/1⟧⟦/0⟧ end.');
    expect(segmentProblem(nested ?? source, 'A ⟦0⟧bold ⟦1⟧both⟦/0⟧⟦/1⟧ end.')).toContain('out of order');
  });

  it('refuses a bad segment on reassembly and names it', () => {
    const markdown = 'Keep this.\n\nRun `npm i` now.';
    expect(() => reassemble(markdown, new Map([['s1', 'Run now.']]))).toThrow(
      /Segment s1 was refused: the placeholder ⟦0⟧ is missing/u,
    );
  });

  it('keeps the source text of an untranslated segment', () => {
    expect(reassemble('One.\n\nTwo.', new Map([['s1', 'Deux.']]))).toBe('One.\n\nDeux.\n');
  });

  describe('whole documents', () => {
    const BODY = '## Add the widget\n\nTap [here](https://a.test).\n\n```\nnpm i\n```\n\n![shot](asset://s.png)';

    it('accepts changed words', () => {
      expect(structureProblem(BODY, BODY.replace('Tap', 'Touchez'))).toBeNull();
    });

    it.each([
      ['a changed heading level', BODY.replace('## Add', '### Add'), 'headings'],
      ['an added heading', `${BODY}\n\n# New`, 'headings'],
      ['a changed code block', BODY.replace('npm i', 'npm install'), 'code'],
      ['a changed link target', BODY.replace('a.test', 'b.test'), 'link'],
      ['a changed image target', BODY.replace('asset://s.png', 'https://evil.test/s.png'), 'link or image'],
      ['an added link', `${BODY}\n\n[spam](https://evil.test)`, 'link'],
    ])('rejects %s', (_name, translated, problem) => {
      expect(structureProblem(BODY, translated)).toContain(problem);
    });
  });
});

// Property tests: random documents built from the constructs the corpus covers, in
// English, Korean and Japanese words.
const word = fc.constantFrom(
  'widget',
  'Settings',
  'deploy',
  'the',
  'team',
  '위젯',
  '설정',
  '배포합니다',
  '팀',
  'ウィジェット',
  '設定',
  'デプロイ',
  'チーム',
  '2026',
  'a.b',
);
const words = fc.array(word, { minLength: 1, maxLength: 6 }).map(list => list.join(' '));
const url = fc.constantFrom('https://a.test/x', 'asset://img/a.png', 'https://b.test/path?q=1#h');
const secret = fc.constantFrom('{{user.name}}', '{{plan}}', ':wave:');
const code = fc.constantFrom('npm i', 'yarn verify', 'x = 1');

const inline = fc.oneof(
  words,
  words.map(text => `**${text}**`),
  words.map(text => `*${text}*`),
  words.map(text => `~~${text}~~`),
  fc.tuple(words, url).map(([text, target]) => `[${text}](${target})`),
  fc.tuple(words, url, words).map(([text, target, title]) => `[${text}](${target} "${title}")`),
  fc.tuple(words, url).map(([alt, target]) => `![${alt}](${target})`),
  url.map(target => `see ${target} now`),
  secret,
  code.map(snippet => `\`${snippet}\``),
);
const line = fc.array(inline, { minLength: 1, maxLength: 5 }).map(parts => parts.join(' '));
const block = fc.oneof(
  line,
  fc.tuple(fc.integer({ min: 1, max: 6 }), line).map(([depth, text]) => `${'#'.repeat(depth)} ${text}`),
  fc.array(line, { minLength: 1, maxLength: 4 }).map(items => items.map(item => `- ${item}`).join('\n')),
  fc
    .array(line, { minLength: 1, maxLength: 4 })
    .map(items => items.map((item, i) => `${String(i + 1)}. ${item}`).join('\n')),
  line.map(text => `> ${text}`),
  fc.tuple(code, line).map(([snippet, text]) => `\`\`\`sh\n${snippet}\n${text}\n\`\`\``),
  fc
    .tuple(line, line)
    .map(([a, b]) => `| A | B |\n| --- | --- |\n| ${a.replaceAll('|', '')} | ${b.replaceAll('|', '')} |`),
);
const documentArb = fc.array(block, { minLength: 1, maxLength: 8 }).map(blocks => blocks.join('\n\n'));

describe('help center Markdown round trip (property)', () => {
  it('reassembles an identity translation to the normalized source', () => {
    fc.assert(
      fc.property(documentArb, markdown => {
        expect(reassemble(markdown, identity(segmentMarkdown(markdown)))).toBe(normalizeMarkdown(markdown));
      }),
      { seed: 211, numRuns: 300 },
    );
  });

  it('round-trips arbitrary text built from Markdown punctuation', () => {
    const char = fc.constantFrom(...'ab 위ウ\n*_`[]()<>#!-|\\:/{}⟦⟧&.1'.split(''));
    fc.assert(
      fc.property(
        fc.array(char, { maxLength: 80 }).map(chars => chars.join('')),
        markdown => {
          expect(reassemble(markdown, identity(segmentMarkdown(markdown)))).toBe(normalizeMarkdown(markdown));
        },
      ),
      { seed: 211, numRuns: 500 },
    );
  });

  it('never sends a URL, code or a variable, and keeps structure through any word change', () => {
    fc.assert(
      fc.property(documentArb, markdown => {
        const segments = segmentMarkdown(markdown);
        expect(
          segments.filter(
            ({ text }) => /\{\{|:wave:|npm i|yarn verify|x = 1/u.test(text) || text.match(URL_LIKE) !== null,
          ),
        ).toEqual([]);
        expect(structureProblem(markdown, reassemble(markdown, shout(segments)))).toBeNull();
      }),
      { seed: 211, numRuns: 200 },
    );
  });
});
