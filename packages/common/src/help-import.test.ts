import { describe, expect, it } from 'vitest';

import { bundleFromMintlify, localImagePaths, mintlifyToMarkdown, splitMdxFrontmatter } from './help-import';

describe('Mintlify import', () => {
  it('reads the frontmatter title, quoted or bare', () => {
    expect(splitMdxFrontmatter("---\ntitle: 'iOS 위젯'\ndescription: x\n---\n\nBody")).toEqual({
      title: 'iOS 위젯',
      body: 'Body',
    });
    expect(splitMdxFrontmatter('---\ntitle: Plain\n---\nText').title).toBe('Plain');
    expect(splitMdxFrontmatter('No frontmatter')).toEqual({ title: null, body: 'No frontmatter' });
  });

  it('turns steps into a numbered list, with callouts and images inside', () => {
    const markdown = mintlifyToMarkdown(
      [
        '<Steps>',
        '<Step title="앨범 버튼 선택">',
        '앨범 아이콘을 탭합니다.',
        '',
        '![썸네일](/images/a.webp)',
        '',
        '<Tip>',
        '최근 사진이 보여요.',
        '</Tip>',
        '</Step>',
        '<Step title="사진 선택">',
        '사진을 고릅니다.',
        '</Step>',
        '</Steps>',
      ].join('\n'),
      path => `https://cdn.test${path}`,
    );

    expect(markdown).toBe(
      [
        '1. **앨범 버튼 선택**',
        '',
        '   앨범 아이콘을 탭합니다.',
        '',
        '   ![썸네일](https://cdn.test/images/a.webp)',
        '',
        '   > **Tip:** 최근 사진이 보여요.',
        '',
        '2. **사진 선택**',
        '',
        '   사진을 고릅니다.',
        '',
      ].join('\n'),
    );
  });

  it('turns callouts into labelled quotes, updates into headings, and drops other tags', () => {
    const markdown = mintlifyToMarkdown(
      [
        '<Info>',
        'Line one',
        'Line two',
        '</Info>',
        '',
        '<Update label="v4.1.0" description="2025-07-28">',
        '  - Checkable 연동',
        '</Update>',
        '',
        '<CardGroup cols={2}>Inside</CardGroup>',
      ].join('\n'),
    );

    expect(markdown).toBe(
      [
        '> **Note:** Line one',
        '> Line two',
        '',
        '## v4.1.0 (2025-07-28)',
        '',
        '- Checkable 연동',
        '',
        'Inside',
        '',
      ].join('\n'),
    );
  });

  it('builds the bundle from the navigation, with old paths and folder slugs', () => {
    const bundle = bundleFromMintlify(
      {
        navigation: {
          tabs: [
            { tab: '시작하기', groups: [{ group: '기본', pages: ['features/widget-features', 'features/missing'] }] },
            { tab: 'Mixed', groups: [{ group: 'All', pages: ['a/one', 'b/two'] }] },
          ],
        },
      },
      new Map([
        ['features/widget-features', "---\ntitle: '위젯'\n---\n\n![x](/images/w.png)"],
        ['a/one', 'One'],
        ['b/two', 'Two'],
      ]),
    );

    expect(bundle.collections.map(collection => collection.slug)).toEqual(['features', 'tab-2']);
    expect(bundle.collections[0]?.sections[0]?.articles).toEqual([
      { title: '위젯', slug: 'widget-features', body: '![x](/images/w.png)\n', fromPath: '/features/widget-features' },
    ]);
    expect(localImagePaths('![a](/images/w.png) ![b](https://x.test/b.png)')).toEqual(['/images/w.png']);
  });
});
