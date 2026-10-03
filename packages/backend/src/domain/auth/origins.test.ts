import { describe, expect, it } from 'vitest';

import { mcpResourceOf, resolveAuthOrigins } from '@backend/domain/auth/origins';

describe('resolveAuthOrigins', () => {
  it('production/local: base = SERVICE_DOMAIN (https), trusts both its www and apex form', () => {
    const r = resolveAuthOrigins({ serviceDomain: 'www.mocco.club' });
    expect(r.baseUrl).toBe('https://www.mocco.club');
    expect(r.trustedOrigins).toEqual(['https://www.mocco.club', 'https://mocco.club']);
  });

  it('adds the www variant when SERVICE_DOMAIN is an apex host', () => {
    const r = resolveAuthOrigins({ serviceDomain: 'mocco.work' });
    expect(r.trustedOrigins).toEqual(['https://mocco.work', 'https://www.mocco.work']);
  });

  it('local www mirrors prod: www canonical, apex trusted', () => {
    const r = resolveAuthOrigins({ serviceDomain: 'www.mocco.work' });
    expect(r.baseUrl).toBe('https://www.mocco.work');
    expect(r.trustedOrigins).toEqual(['https://www.mocco.work', 'https://mocco.work']);
  });

  it('preview: trusts only this deployment’s own Vercel URLs; base = branch alias', () => {
    const r = resolveAuthOrigins({
      vercelEnv: 'preview',
      vercelUrl: 'mocco-abc123-fi-workers.vercel.app',
      vercelBranchUrl: 'mocco-git-feat-x-fi-workers.vercel.app',
    });
    expect(r.baseUrl).toBe('https://mocco-git-feat-x-fi-workers.vercel.app');
    expect(r.trustedOrigins).toEqual([
      'https://mocco-abc123-fi-workers.vercel.app',
      'https://mocco-git-feat-x-fi-workers.vercel.app',
    ]);
    // never a *.vercel.app wildcard, never SERVICE_DOMAIN in preview
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

  it('a trailing-dot host still normalizes to a clean origin', () => {
    const r = resolveAuthOrigins({ serviceDomain: 'www.mocco.club.' });
    expect(r.trustedOrigins).toEqual(['https://www.mocco.club.', 'https://mocco.club.']);
  });

  it('loopback SERVICE_DOMAIN (host:port) composes http, not https', () => {
    const r = resolveAuthOrigins({ serviceDomain: 'localhost:3100' });
    expect(r.baseUrl).toBe('http://localhost:3100');
    expect(r.trustedOrigins).toContain('http://localhost:3100');
  });
});

describe('mcpResourceOf', () => {
  it('anchors the resource to the app origin', () => {
    expect(mcpResourceOf(resolveAuthOrigins({ serviceDomain: 'www.mocco.club' }))).toBe(
      'https://www.mocco.club/api/mcp',
    );
  });

  it('stays http on loopback, which the resource identifier allows only there', () => {
    expect(mcpResourceOf(resolveAuthOrigins({ serviceDomain: 'localhost:3100' }))).toBe(
      'http://localhost:3100/api/mcp',
    );
  });

  it('follows a preview to its own deployment URL', () => {
    const origins = resolveAuthOrigins({
      vercelEnv: 'preview',
      vercelUrl: 'a.vercel.app',
      vercelBranchUrl: 'b.vercel.app',
    });

    expect(mcpResourceOf(origins)).toBe('https://b.vercel.app/api/mcp');
  });

  it('is undefined with no base URL, so the server is left unconfigured rather than guessed', () => {
    expect(mcpResourceOf(resolveAuthOrigins({}))).toBeUndefined();
    expect(mcpResourceOf(resolveAuthOrigins({ vercelEnv: 'preview' }))).toBeUndefined();
  });

  it('carries no query, fragment or credentials — the identifier must be canonical', () => {
    const resource = mcpResourceOf(resolveAuthOrigins({ serviceDomain: 'www.mocco.club' })) ?? '';
    const url = new URL(resource);

    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.username).toBe('');
  });
});
