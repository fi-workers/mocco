import { describe, expect, it } from 'vitest';

import { searchArticles } from '@backend/domain/helpcenter/search';

const articles = [
  { title: 'iOS 위젯', body: '홈 화면 위젯으로 바로 **촬영**을 시작하세요.\n\n```\ncode 위젯\n```', path: '/ko/a' },
  { title: '카메라 기능', body: '위젯이 아니라 앱에서 촬영하는 방법이에요. [링크](https://x.test)', path: '/ko/b' },
  { title: 'Coupons', body: 'Redeem a coupon in Settings.', path: '/ko/c' },
];

describe('help center search', () => {
  it('ranks title matches first and needs every term', () => {
    expect(searchArticles(articles, '위젯', 10).map(hit => hit.path)).toEqual(['/ko/a', '/ko/b']);
    expect(searchArticles(articles, '위젯 촬영', 10).map(hit => hit.path)).toEqual(['/ko/a', '/ko/b']);
    expect(searchArticles(articles, '위젯 coupon', 10)).toEqual([]);
    expect(searchArticles(articles, 'COUPON', 10).map(hit => hit.title)).toEqual(['Coupons']);
  });

  it('snips plain text around the match, without Markdown or code', () => {
    const [hit] = searchArticles(articles, '촬영', 1);
    expect(hit?.snippet).toBe('홈 화면 위젯으로 바로 촬영 을 시작하세요.');
    expect(searchArticles(articles, '링크', 1)[0]?.snippet).toContain('링크');
    expect(searchArticles(articles, ' '.repeat(3), 10)).toEqual([]);
  });
});
