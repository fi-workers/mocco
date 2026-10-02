// A project's help center in the console (#96): set it up (address and languages), then
// its collections → sections → articles, with each article's state. Writing happens in
// the article editor.
import { HELP_LOCALE_NAMES, HELP_LOCALES, slugify } from '@mocco/common/help';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import {
  errorMessage,
  inputClass,
  labelClass,
  Spinner,
  StatusBadge,
  Tones,
} from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { Routes } from '@frontend/lib/routes';
import { trpc } from '@frontend/lib/trpc';

import type { HelpLocale } from '@mocco/common/help';

interface Props {
  workspaceId: string;
  projectId: string;
}

/** The public site's host (`<slug>.<HELP_SITES_DOMAIN>`, which may carry a port locally), or null. */
export function publicSiteHost(slug: string): { host: string; url: string } | null {
  const domain = process.env.NEXT_PUBLIC_HELP_SITES_DOMAIN ?? '';
  if (domain === '') {
    return null;
  }
  const host = `${slug}.${domain}`;
  // eslint-disable-next-line sonarjs/null-dereference -- domain is a string, never null
  return { host, url: `${domain.startsWith('help.localhost') ? 'http' : 'https'}://${host}` };
}

/** Nothing but spaces. */
// eslint-disable-next-line sonarjs/null-dereference -- value is a string, never null
const isBlank = (value: string) => value.trim() === '';

function Setup({ workspaceId, projectId, projectName }: Props & { projectName: string }) {
  const utils = trpc.useUtils();
  const enable = trpc.help.enable.useMutation({
    onSuccess: async () => {
      await utils.help.site.invalidate();
    },
  });
  const [slug, setSlug] = useState(() => slugify(projectName));
  const [sourceLocale, setSourceLocale] = useState<HelpLocale>('en');
  const [locales, setLocales] = useState<HelpLocale[]>([]);
  const toggleLocale = (locale: HelpLocale, isOn: boolean) => {
    setLocales(current => (isOn ? [...current, locale] : current.filter(entry => entry !== locale)));
  };

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Set up the help center</h2>
        <p className="text-sm text-muted-foreground">
          Write your product&apos;s help in Markdown and publish it as a public site. Pick its address, the language you
          write in, and the languages you&apos;ll offer; until an article is translated, readers get it in the language
          you write in.
        </p>
      </div>
      <label className={labelClass} htmlFor="help-slug">
        Address
        <input
          id="help-slug"
          className={inputClass}
          value={slug}
          onChange={event => {
            setSlug(event.target.value.toLowerCase());
          }}
        />
      </label>
      <label className={labelClass} htmlFor="help-source">
        Written in
        <select
          id="help-source"
          className={inputClass}
          value={sourceLocale}
          onChange={event => {
            const next = event.target.value as HelpLocale;
            setSourceLocale(next);
            setLocales(current => current.filter(locale => locale !== next));
          }}>
          {HELP_LOCALES.map(locale => (
            <option key={locale} value={locale}>
              {HELP_LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium text-muted-foreground">Also offered in</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {HELP_LOCALES.filter(locale => locale !== sourceLocale).map(locale => (
            <label key={locale} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={locales.includes(locale)}
                onChange={event => {
                  toggleLocale(locale, event.target.checked);
                }}
              />
              {HELP_LOCALE_NAMES[locale]}
            </label>
          ))}
        </div>
      </fieldset>
      <Button
        className="w-fit text-sm"
        pending={enable.isPending}
        onClick={() => {
          enable.mutate({ workspaceId, projectId, slug, sourceLocale, locales });
        }}>
        Set up help center
      </Button>
      {enable.error ? <p className="text-sm text-destructive">{errorMessage(enable.error)}</p> : null}
    </section>
  );
}

function AddCollection({ workspaceId, projectId }: Props) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState('');
  const create = trpc.help.createCollection.useMutation({
    onSuccess: async () => {
      setTitle('');
      await utils.help.tree.invalidate();
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({ workspaceId, projectId, title, slug: slugify(title) });
      }}>
      <label className={labelClass} htmlFor="help-new-collection">
        New collection
        <input
          id="help-new-collection"
          className={inputClass}
          placeholder="Getting started"
          value={title}
          onChange={event => {
            setTitle(event.target.value);
          }}
        />
      </label>
      <Button type="submit" variant="outline" className="text-sm" pending={create.isPending} disabled={isBlank(title)}>
        Add collection
      </Button>
      {create.error ? <p className="w-full text-sm text-destructive">{errorMessage(create.error)}</p> : null}
    </form>
  );
}

function AddSection({ workspaceId, projectId, collectionId }: Props & { collectionId: string }) {
  const utils = trpc.useUtils();
  const [title, setTitle] = useState('');
  const create = trpc.help.createSection.useMutation({
    onSuccess: async () => {
      setTitle('');
      await utils.help.tree.invalidate();
    },
  });
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({ workspaceId, projectId, collectionId, title });
      }}>
      <input
        aria-label="New section"
        className={inputClass}
        placeholder="New section"
        value={title}
        onChange={event => {
          setTitle(event.target.value);
        }}
      />
      <Button type="submit" variant="outline" className="text-sm" pending={create.isPending} disabled={isBlank(title)}>
        Add section
      </Button>
    </form>
  );
}

function AddArticle({ workspaceId, projectId, sectionId }: Props & { sectionId: string }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const create = trpc.help.createArticle.useMutation({
    onSuccess: async article => {
      await router.push(Routes.projectHelpArticle(workspaceId, projectId, article.id));
    },
  });
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={event => {
        event.preventDefault();
        create.mutate({ workspaceId, projectId, sectionId, title });
      }}>
      <input
        aria-label="New article"
        className={inputClass}
        placeholder="New article title"
        value={title}
        onChange={event => {
          setTitle(event.target.value);
        }}
      />
      <Button type="submit" variant="outline" className="text-sm" pending={create.isPending} disabled={isBlank(title)}>
        Add article
      </Button>
    </form>
  );
}

function Tree({ workspaceId, projectId }: Props) {
  const treeQuery = trpc.help.tree.useQuery({ workspaceId, projectId });
  if (treeQuery.isPending) {
    return <Spinner />;
  }
  if (treeQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(treeQuery.error)}</p>;
  }
  const { collections } = treeQuery.data;
  return (
    <div className="flex flex-col gap-6">
      {collections.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Start with a collection, such as &ldquo;Getting started&rdquo;. Collections hold sections, and sections hold
          articles.
        </p>
      ) : null}
      {collections.map(collection => (
        <section key={collection.id} className="flex flex-col gap-3 rounded-xl border border-border p-4">
          <h3 className="font-medium">{collection.title}</h3>
          {collection.sections.map(section => (
            <div key={section.id} className="flex flex-col gap-2 border-t border-border pt-3">
              <h4 className="text-sm font-medium">{section.title}</h4>
              <ul className="flex flex-col gap-1">
                {section.articles.map(article => (
                  <li key={article.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <Link
                      href={Routes.projectHelpArticle(workspaceId, projectId, article.id)}
                      className="underline-offset-2 hover:underline">
                      {article.title || 'Untitled'}
                    </Link>
                    {article.status === 'published' ? (
                      <StatusBadge tone={Tones.ok}>Published</StatusBadge>
                    ) : (
                      <StatusBadge tone={Tones.neutral}>Draft</StatusBadge>
                    )}
                    {article.status === 'published' && article.hasUnpublishedChanges ? (
                      <StatusBadge tone={Tones.warn}>Unpublished changes</StatusBadge>
                    ) : null}
                  </li>
                ))}
              </ul>
              <AddArticle workspaceId={workspaceId} projectId={projectId} sectionId={section.id} />
            </div>
          ))}
          <AddSection workspaceId={workspaceId} projectId={projectId} collectionId={collection.id} />
        </section>
      ))}
      <AddCollection workspaceId={workspaceId} projectId={projectId} />
    </div>
  );
}

export default function HelpCenter({ workspaceId, projectId }: Props) {
  const siteQuery = trpc.help.site.useQuery({ workspaceId, projectId });
  const projectQuery = trpc.project.get.useQuery({ workspaceId, projectId }, { retry: false });
  if (siteQuery.isPending || projectQuery.isPending) {
    return <Spinner />;
  }
  if (siteQuery.error) {
    return <p className="text-sm text-destructive">{errorMessage(siteQuery.error)}</p>;
  }
  const { site } = siteQuery.data;
  if (site === null) {
    return (
      <Setup workspaceId={workspaceId} projectId={projectId} projectName={projectQuery.data?.project.name ?? ''} />
    );
  }
  const publicSite = publicSiteHost(site.slug);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>
          Written in {(HELP_LOCALE_NAMES as Record<string, string>)[site.sourceLocale] ?? site.sourceLocale}
          {site.locales.length > 0
            ? `, also offered in ${site.locales.map(locale => (HELP_LOCALE_NAMES as Record<string, string>)[locale] ?? locale).join(', ')}`
            : ''}
        </span>
        {publicSite === null ? null : (
          <a
            href={publicSite.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-foreground underline underline-offset-2">
            {publicSite.host}
          </a>
        )}
      </div>
      <Tree workspaceId={workspaceId} projectId={projectId} />
    </div>
  );
}
