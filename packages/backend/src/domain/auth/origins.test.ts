import { describe, expect, it } from 'vitest';

import { resolveAuthOrigins } from './origins';

describe('resolveAuthOrigins', () => {
  it('production/local: base = AUTH_URL, trusts both its www and apex form', () => {
    const r = resolveAuthOrigins({ authUrl: 'https://www.mocco.club' });
    expect(r.baseUrl).toBe('https://www.mocco.club');
    expect(r.trustedOrigins).toEqual(['https://www.mocco.club', 'https://mocco.club']);
  });

  it('adds the www variant when AUTH_URL is an apex host', () => {
    const r = resolveAuthOrigins({ authUrl: 'https://mocco.work' });
    expect(r.trustedOrigins).toEqual(['https://mocco.work', 'https://www.mocco.work']);
  });

  it('local www mirrors prod: www canonical, apex trusted', () => {
    const r = resolveAuthOrigins({ authUrl: 'https://www.mocco.work' });
    expect(r.baseUrl).toBe('https://www.mocco.work');
    expect(r.trustedOrigins).toEqual(['https://www.mocco.work', 'https://mocco.work']);
  });

  it('preview: trusts only this deployment’s own Vercel URLs; base = branch alias', () => {
    const r = resolveAuthOrigins({
      authUrl: 'https://www.mocco.club',
      vercelEnv: 'preview',
      vercelUrl: 'mocco-abc123-fi-workers.vercel.app',
      vercelBranchUrl: 'mocco-git-feat-x-fi-workers.vercel.app',
    });
    expect(r.baseUrl).toBe('https://mocco-git-feat-x-fi-workers.vercel.app');
    expect(r.trustedOrigins).toEqual([
      'https://mocco-abc123-fi-workers.vercel.app',
      'https://mocco-git-feat-x-fi-workers.vercel.app',
    ]);
    // never a *.vercel.app wildcard, never AUTH_URL in preview
    expect(r.trustedOrigins).not.toContain('https://www.mocco.club');
  });

  it('preview with only VERCEL_URL: base falls back to it', () => {
    const r = resolveAuthOrigins({ vercelEnv: 'preview', vercelUrl: 'mocco-abc.vercel.app' });
    expect(r.baseUrl).toBe('https://mocco-abc.vercel.app');
    expect(r.trustedOrigins).toEqual(['https://mocco-abc.vercel.app']);
  });

  it('no config: no base and no trusted origins (fail-safe empty)', () => {
    const r = resolveAuthOrigins({});
    expect(r.baseUrl).toBeUndefined();
    expect(r.trustedOrigins).toEqual([]);
  });

  it('normalizes AUTH_URL to an origin (drops path/trailing slash)', () => {
    const r = resolveAuthOrigins({ authUrl: 'https://www.mocco.club/' });
    expect(r.trustedOrigins).toEqual(['https://www.mocco.club', 'https://mocco.club']);
  });
});
