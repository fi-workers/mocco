// Import a Mintlify docs folder into the help center (#96). The folder is read and
// converted in the browser: docs.json's navigation becomes the tree, MDX becomes
// Markdown, the images the pages use are uploaded to storage first, and the articles
// are sent one collection at a time. Importing again updates the same articles.

import { bundleFromMintlify, localImagePaths, mintlifyDocsSchema } from '@mocco/common/help-import';
import { useState } from 'react';

import { useHelpImageUpload } from '@frontend/components/help/use-help-image-upload';
import { errorMessage, labelClass, Notice, Tones } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { trpc } from '@frontend/lib/trpc';

import type { HelpImageType } from '@mocco/common/help';
import type { ImportBundle } from '@mocco/common/help-import';

interface Props {
  workspaceId: string;
  projectId: string;
}

const IMAGE_TYPES: Record<string, HelpImageType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

interface Outcome {
  created: number;
  updated: number;
  unchanged: number;
  images: number;
  missingImages: string[];
  notInNavigation: string[];
}

/** The folder's files by path inside it (`features/widget.mdx`, `images/a.png`). */
function filesByPath(files: FileList): Map<string, File> {
  return new Map(
    [...files].map(file => {
      const relative = file.webkitRelativePath === '' ? file.name : file.webkitRelativePath;
      return [relative.slice(relative.indexOf('/') + 1), file] as const;
    }),
  );
}

/** The folder's MDX pages that docs.json's navigation doesn't list (README files aside). */
function pagesOutsideNavigation(byPath: ReadonlyMap<string, File>, pages: ReadonlyMap<string, string>): string[] {
  /* eslint-disable sonarjs/null-dereference -- every path is a string, never null */
  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray isn't in every browser the console supports
  const pagePaths = [...byPath.keys()].filter(path => /\.mdx?$/u.test(path) && !/(?:^|\/)readme\.md$/iu.test(path));
  return pagePaths.map(path => path.replace(/\.mdx?$/u, '')).filter(page => !pages.has(page));
  /* eslint-enable sonarjs/null-dereference */
}

/** Every local image path the bundle's articles use. */
function imagesOf(bundle: ImportBundle): Set<string> {
  const articles = bundle.collections.flatMap(collection => collection.sections.flatMap(section => section.articles));
  return new Set(articles.flatMap(article => localImagePaths(article.body)));
}

export default function ImportMintlify({ workspaceId, projectId }: Props) {
  const utils = trpc.useUtils();
  const images = useHelpImageUpload(workspaceId, projectId);
  const importBundle = trpc.help.importBundle.useMutation();
  const [files, setFiles] = useState<FileList | null>(null);
  const [shouldPublish, setShouldPublish] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const uploadImage = async (path: string, file: File): Promise<string | null> => {
    // eslint-disable-next-line sonarjs/null-dereference -- path is a string, never null
    const contentType = IMAGE_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] as HelpImageType | undefined;
    if (contentType === undefined) {
      return null;
    }
    return await images.upload(file, contentType, file.name);
  };

  const run = async (picked: FileList) => {
    setOutcome(null);
    setProblem(null);
    const byPath = filesByPath(picked);
    const docsFile = byPath.get('docs.json') ?? byPath.get('mint.json');
    if (docsFile === undefined) {
      setProblem('No docs.json in that folder. Pick the folder that has docs.json at its top.');
      return;
    }
    const docs = mintlifyDocsSchema.safeParse(JSON.parse(await docsFile.text()));
    if (!docs.success) {
      setProblem("docs.json doesn't have the navigation (tabs → groups → pages) this import reads.");
      return;
    }
    const navPages = docs.data.navigation.tabs.flatMap(tab => tab.groups.flatMap(group => group.pages));
    const pages = new Map<string, string>();
    await Promise.all(
      navPages.map(async page => {
        const file = byPath.get(`${page}.mdx`) ?? byPath.get(`${page}.md`);
        if (file !== undefined) {
          pages.set(page, await file.text());
        }
      }),
    );
    const notInNavigation = pagesOutsideNavigation(byPath, pages);

    // Upload the images the pages use, once each.
    const firstPass = bundleFromMintlify(docs.data, pages);
    const imagePaths = imagesOf(firstPass);
    const urls = new Map<string, string>();
    const missingImages: string[] = [];
    let done = 0;
    // eslint-disable-next-line no-restricted-syntax -- one upload at a time keeps the progress honest
    for (const path of imagePaths) {
      done += 1;
      setProgress(`Uploading images (${done} of ${imagePaths.size})…`);
      const file = byPath.get(path.replace(/^\//u, ''));
      // eslint-disable-next-line no-await-in-loop -- sequential uploads, see above
      const url = file === undefined ? null : await uploadImage(path, file);
      if (url === null) {
        missingImages.push(path);
      } else {
        urls.set(path, url);
      }
    }

    const bundle = bundleFromMintlify(docs.data, pages, path => urls.get(path) ?? path);
    const totals = { created: 0, updated: 0, unchanged: 0 };
    // eslint-disable-next-line no-restricted-syntax -- one collection per request keeps each under the body limit
    for (const [index, collection] of bundle.collections.entries()) {
      setProgress(`Importing ${collection.title} (${index + 1} of ${bundle.collections.length})…`);
      // eslint-disable-next-line no-await-in-loop -- sequential, see above
      const counts = await importBundle.mutateAsync({
        workspaceId,
        projectId,
        bundle: { collections: [collection] },
        publish: shouldPublish,
      });
      totals.created += counts.created;
      totals.updated += counts.updated;
      totals.unchanged += counts.unchanged;
    }
    setProgress(null);
    setOutcome({ ...totals, images: urls.size, missingImages, notInNavigation });
    await utils.help.tree.invalidate();
  };

  const error = images.error ?? importBundle.error;

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">Import from Mintlify</h3>
        <p className="max-w-prose text-sm text-muted-foreground">
          Pick your Mintlify docs folder (the one with docs.json). Its tabs, groups and pages become collections,
          sections and articles; the images the pages use are uploaded; and every page&apos;s old address redirects to
          its article. Importing again updates the same articles.
        </p>
      </div>
      <label className={labelClass} htmlFor="help-import-folder">
        Docs folder
        <input
          id="help-import-folder"
          type="file"
          multiple
          // A folder picker: not in React's types, so set as a plain attribute.
          {...{ webkitdirectory: '' }}
          className="text-sm"
          onChange={event => {
            setFiles(event.target.files);
          }}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={shouldPublish}
          onChange={event => {
            setShouldPublish(event.target.checked);
          }}
        />
        Publish the imported articles
      </label>
      <Button
        variant="outline"
        className="w-fit text-sm"
        disabled={files === null || progress !== null}
        pending={progress !== null}
        onClick={async () => {
          if (files === null) {
            return;
          }
          try {
            await run(files);
          } catch (error_) {
            setProgress(null);
            setProblem(error_ instanceof Error ? error_.message : String(error_));
          }
        }}>
        Import
      </Button>
      {progress === null ? null : <p className="text-sm text-muted-foreground">{progress}</p>}
      {problem === null ? null : <p className="text-sm text-destructive">{problem}</p>}
      {error ? <p className="text-sm text-destructive">{errorMessage(error)}</p> : null}
      {outcome === null ? null : (
        <Notice tone={Tones.ok} title="Imported">
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            <li>
              {outcome.created} new, {outcome.updated} updated, {outcome.unchanged} unchanged articles
              {shouldPublish ? ', all published' : ''}.
            </li>
            <li>{outcome.images} images uploaded or already stored.</li>
            {outcome.missingImages.length > 0 ? (
              <li>Images not found in the folder: {outcome.missingImages.join(', ')}</li>
            ) : null}
            {outcome.notInNavigation.length > 0 ? (
              <li>Pages not in docs.json&apos;s navigation, not imported: {outcome.notInNavigation.join(', ')}</li>
            ) : null}
          </ul>
        </Notice>
      )}
    </section>
  );
}
