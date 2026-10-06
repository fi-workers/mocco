import { describe, expect, it } from 'vitest';

import { HelpSiteNotFoundError } from '@backend/domain/helpcenter/errors';
import { helpSiteForHost, helpSiteOrigin } from '@backend/domain/helpcenter/site-url';
import { agentFile, AgentFiles, llmsTxt } from '@backend/transport/seo/agents';

import type { AgentFileDeps } from '@backend/transport/seo/agents';

const env = { HELP_SITES_DOMAIN: 'help.mocco.club', HELP_CUSTOM_DOMAINS: 'help.syt.app=syt' };

const deps = (): AgentFileDeps => ({
  appOrigin: 'https://www.mocco.club',
  guides: () => [
    {
      label: 'Getting started',
      guides: [
        {
          path: '/docs/start/overview',
          title: 'What Mocco offers',
          description: 'The products.',
          markdown: '# What Mocco offers\n\nBody.\n',
        },
      ],
    },
  ],
  helpSiteForHost: host => helpSiteForHost(host, env),
  helpSiteOrigin: slug => helpSiteOrigin(slug, env),
  help: {
    site: async slug => {
      if (slug !== 'syt') {
        throw new HelpSiteNotFoundError(slug);
      }
      return await Promise.resolve({
        slug,
        name: 'ShowYourTime',
        sourceLocale: 'ko',
        locales: ['en'],
        allowAiTraining: true,
      });
    },
    forAgents: async (_slug, locale) =>
      await Promise.resolve({
        name: 'ShowYourTime',
        locale,
        collections: [
          {
            title: 'Start',
            sections: [
              {
                title: 'Basics',
                articles: [{ title: 'Widget', path: `/${locale}/articles/abc123-widget`, body: 'Tap here.' }],
              },
            ],
          },
        ],
      }),
    article: async (_slug, locale, ref) =>
      await Promise.resolve(
        ref === 'abc123-widget'
          ? {
              articleId: '00000000-0000-4000-8000-000000000001',
              shortId: 'abc123',
              slug: 'widget',
              locale,
              title: 'Widget',
              body: 'Tap here.\n',
              publishedAt: null,
              modifiedAt: null,
              locales: ['ko'],
              canonicalPath: '/ko/articles/abc123-widget',
              sourceLocale: 'ko',
              translation: null,
            }
          : undefined,
      ),
  },
});

describe('llmsTxt', () => {
  it('writes the llmstxt.org shape: title, summary quote, a link list per section', () => {
    expect(
      llmsTxt({
        title: 'Mocco',
        summary: 'All of it.',
        sections: [
          { title: 'Start', links: [{ title: 'Overview', url: 'https://a.test/o.md', description: 'What.' }] },
        ],
      }),
    ).toBe('# Mocco\n\n> All of it.\n\n## Start\n\n- [Overview](https://a.test/o.md): What.\n');
  });
});

describe('agentFile', () => {
  it("indexes the app's guides by their Markdown URLs and serves one guide's Markdown", async () => {
    const index = await agentFile('www.mocco.club', { file: AgentFiles.llms }, deps());
    const full = await agentFile('www.mocco.club', { file: AgentFiles.llmsFull }, deps());
    const guide = await agentFile('www.mocco.club', { file: AgentFiles.guide, path: '/docs/start/overview' }, deps());
    const missing = await agentFile('www.mocco.club', { file: AgentFiles.guide, path: '/docs/start/nope' }, deps());

    expect(index.body).toContain(
      '## Getting started\n\n- [What Mocco offers](https://www.mocco.club/docs/start/overview.md): The products.',
    );
    expect(full.body).toContain('Source: https://www.mocco.club/docs/start/overview\n\n# What Mocco offers\n\nBody.');
    expect([guide.status, guide.contentType, guide.body]).toEqual([
      200,
      'text/markdown; charset=utf-8',
      '# What Mocco offers\n\nBody.\n',
    ]);
    expect(missing.status).toBe(404);
  });

  it("indexes a help site per language on its canonical origin, and serves an article's Markdown", async () => {
    const source = await agentFile('syt.help.mocco.club', { file: AgentFiles.llms }, deps());
    const english = await agentFile('help.syt.app', { file: AgentFiles.llms, locale: 'en' }, deps());
    const article = await agentFile(
      'help.syt.app',
      { file: AgentFiles.article, locale: 'ko', path: 'abc123-widget' },
      deps(),
    );

    expect(source.body).toContain('# ShowYourTime\n');
    expect(source.body).toContain('## Start — Basics\n\n- [Widget](https://help.syt.app/ko/articles/abc123-widget.md)');
    expect(english.body).toContain('(https://help.syt.app/en/articles/abc123-widget.md)');
    expect(article.body).toBe('# Widget\n\nTap here.\n');
  });

  it('answers 404 for a language the site lacks, a missing site, or the other host kind', async () => {
    const results = await Promise.all([
      agentFile('help.syt.app', { file: AgentFiles.llms, locale: 'fr' }, deps()),
      agentFile('gone.help.mocco.club', { file: AgentFiles.llms }, deps()),
      agentFile('help.syt.app', { file: AgentFiles.guide, path: '/docs/start/overview' }, deps()),
      agentFile('www.mocco.club', { file: AgentFiles.llms, locale: 'en' }, deps()),
    ]);

    expect(results.map(result => result.status)).toEqual([404, 404, 404, 404]);
  });
});
