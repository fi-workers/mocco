// What coding agents and AI assistants read (#366): llms.txt (an index of every page's
// Markdown, llmstxt.org format), llms-full.txt (every page's Markdown in one file), and the
// Markdown of one page. The app's host serves Mocco's customer guides; a help center's host
// serves that site's published articles, in a language of the site. Pure over its inputs,
// like seo/files.ts, so the Next route stays a thin adapter.

import { HelpSiteNotFoundError } from '@backend/domain/helpcenter/errors';

import type { HelpPublicReadService } from '@backend/domain/helpcenter/HelpPublicReadService';
import type { SeoFileResponse } from '@backend/transport/seo/files';

export const AgentFiles = {
  /** An index: each page's title and Markdown URL, grouped by section. */
  llms: 'llms',
  /** Every page's Markdown, one after another. */
  llmsFull: 'llms-full',
  /** One customer guide's Markdown (app host). */
  guide: 'guide',
  /** One help article's Markdown (help host). */
  article: 'article',
} as const;
export type AgentFile = (typeof AgentFiles)[keyof typeof AgentFiles];

/** Mocco's customer guides, as the frontend reads them from docs/customer. */
export interface GuideSetForAgents {
  label: string;
  guides: readonly { path: string; title: string; description: string; markdown: string }[];
}

export interface AgentFileDeps {
  appOrigin: string;
  guides: () => readonly GuideSetForAgents[];
  helpSiteForHost: (host: string) => string | null;
  helpSiteOrigin: (slug: string) => string | null;
  help: Pick<HelpPublicReadService, 'site' | 'forAgents' | 'article'>;
}

export interface AgentFileRequest {
  file: AgentFile;
  /** A help site's language; the source language when absent. */
  locale?: string;
  /** A guide's `/docs/<set>/<page>` path, or an article's `{shortId}-{slug}` ref. */
  path?: string;
}

const TEXT = 'text/plain; charset=utf-8';
const MARKDOWN = 'text/markdown; charset=utf-8';
const notFound: SeoFileResponse = { status: 404, contentType: TEXT, body: 'Not found\n' };

interface Index {
  title: string;
  summary: string;
  sections: readonly { title: string; links: readonly { title: string; url: string; description?: string }[] }[];
}

/** llms.txt: a title, a one-line summary as a quote, then a list of links per section. */
export function llmsTxt(index: Index): string {
  return [
    `# ${index.title}`,
    '',
    `> ${index.summary}`,
    '',
    ...index.sections.flatMap(section => [
      `## ${section.title}`,
      '',
      ...section.links.map(link => {
        const note = link.description === undefined || link.description === '' ? '' : `: ${link.description}`;
        return `- [${link.title}](${link.url})${note}`;
      }),
      '',
    ]),
  ].join('\n');
}

/** Pages one after another, each opening with its own heading and source URL. */
function concatenated(title: string, pages: readonly { url: string; markdown: string }[]): string {
  return [
    `# ${title}`,
    '',
    ...pages.flatMap(page => ['---', '', `Source: ${page.url}`, '', page.markdown.trim(), '']),
  ].join('\n');
}

const ok = (contentType: string, body: string): SeoFileResponse => ({ status: 200, contentType, body });

function appFile(request: AgentFileRequest, deps: AgentFileDeps): SeoFileResponse {
  const sets = deps.guides();
  if (request.file === AgentFiles.llms) {
    return ok(
      TEXT,
      llmsTxt({
        title: 'Mocco',
        summary:
          'Everything a product needs to be built and run, except the code: deploy governance, OTA updates, feature flags, a status page, notifications, in-app messaging and a help center in one workspace. These are the customer guides, as Markdown.',
        sections: sets.map(set => ({
          title: set.label,
          links: set.guides.map(guide => ({
            title: guide.title,
            url: `${deps.appOrigin}${guide.path}.md`,
            description: guide.description,
          })),
        })),
      }),
    );
  }
  if (request.file === AgentFiles.llmsFull) {
    return ok(
      TEXT,
      concatenated(
        'Mocco customer guides',
        sets.flatMap(set =>
          set.guides.map(guide => ({ url: `${deps.appOrigin}${guide.path}`, markdown: guide.markdown })),
        ),
      ),
    );
  }
  if (request.file === AgentFiles.guide) {
    const guide = sets.flatMap(set => set.guides).find(candidate => candidate.path === request.path);
    return guide === undefined ? notFound : ok(MARKDOWN, `${guide.markdown.trim()}\n`);
  }
  return notFound;
}

async function helpFile(slug: string, origin: string, request: AgentFileRequest, deps: AgentFileDeps) {
  const site = await deps.help.site(slug);
  const locale = request.locale ?? site.sourceLocale;
  if (locale !== site.sourceLocale && !site.locales.includes(locale)) {
    return notFound;
  }
  if (request.file === AgentFiles.article) {
    const article = await deps.help.article(slug, locale, request.path ?? '');
    return article === undefined ? notFound : ok(MARKDOWN, `# ${article.title}\n\n${article.body.trim()}\n`);
  }
  const content = await deps.help.forAgents(slug, locale);
  const articles = content.collections.flatMap(collection => collection.sections.flatMap(section => section.articles));
  if (request.file === AgentFiles.llms) {
    return ok(
      TEXT,
      llmsTxt({
        title: content.name,
        summary: `The ${content.name} help center's articles, as Markdown.`,
        sections: content.collections.flatMap(collection =>
          collection.sections.map(section => ({
            title: section.title === collection.title ? section.title : `${collection.title} — ${section.title}`,
            links: section.articles.map(article => ({ title: article.title, url: `${origin}${article.path}.md` })),
          })),
        ),
      }),
    );
  }
  if (request.file === AgentFiles.llmsFull) {
    return ok(
      TEXT,
      concatenated(
        content.name,
        articles.map(article => ({
          url: `${origin}${article.path}`,
          markdown: `# ${article.title}\n\n${article.body}`,
        })),
      ),
    );
  }
  return notFound;
}

export async function agentFile(
  host: string,
  request: AgentFileRequest,
  deps: AgentFileDeps,
): Promise<SeoFileResponse> {
  const slug = deps.helpSiteForHost(host);
  if (slug === null) {
    return request.locale === undefined ? appFile(request, deps) : notFound;
  }
  const origin = deps.helpSiteOrigin(slug);
  if (origin === null || request.file === AgentFiles.guide) {
    return notFound;
  }
  try {
    return await helpFile(slug, origin, request, deps);
  } catch (error) {
    if (error instanceof HelpSiteNotFoundError) {
      return notFound;
    }
    throw error;
  }
}
