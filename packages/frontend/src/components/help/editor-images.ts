// Images in the article editor (#208): pasted, dropped or picked files are uploaded to
// the help center's storage and land in the Markdown as `![name](public URL)`, the same
// reference an import writes. While a file uploads, a placeholder holds its place, so
// typing meanwhile doesn't move where it lands.

import { useState } from 'react';

import { helpImageProblem, helpImageTypeOf, useHelpImageUpload } from '@frontend/components/help/use-help-image-upload';
import { fireAndForget } from '@frontend/lib/fire-and-forget';

import type { ClipboardEvent, DragEvent, RefObject } from 'react';

/** The image's alt text: its file name without the extension or Markdown brackets. */
function altOf(filename: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- filename is a string, never null
  return filename.replace(/\.[a-z0-9]+$/iu, '').replaceAll(/[[\]]/gu, '');
}

const placeholderOf = (filename: string, id: string) => `![Uploading ${altOf(filename)}…](#uploading-${id})`;

/** How many newlines (up to two) a text already has at an edge, asked through `hasAtEdge`. */
function edgeNewlines(hasAtEdge: (newlines: string) => boolean): number {
  if (hasAtEdge('\n\n')) {
    return 2;
  }
  return hasAtEdge('\n') ? 1 : 0;
}

/** The newlines that make a blank line between `text` and a block, given those it already has at that edge. */
function gapAt(text: string, newlinesAtEdge: number): string {
  return text === '' ? '' : '\n'.repeat(2 - Math.min(newlinesAtEdge, 2));
}

/** Put `block` in place of the selection as its own paragraph: blank lines around it, unless at an edge. */
function insertBlock(body: string, start: number, end: number, block: string): string {
  /* eslint-disable sonarjs/null-dereference -- body and its slices are strings, never null */
  const before = body.slice(0, start);
  const after = body.slice(end);
  const lead = gapAt(
    before,
    edgeNewlines(suffix => before.endsWith(suffix)),
  );
  const trail = gapAt(
    after,
    edgeNewlines(prefix => after.startsWith(prefix)),
  );
  /* eslint-enable sonarjs/null-dereference */
  return `${before}${lead}${block}${trail}${after}`;
}

/** The files in a paste or drop. */
const filesOf = (data: DataTransfer): File[] => [...data.files];

/** Dragging files over the editor allows dropping them (text drags behave as usual). */
function onDragOver(event: DragEvent<HTMLTextAreaElement>) {
  if (event.dataTransfer.types.includes('Files')) {
    event.preventDefault();
  }
}

export function useEditorImages({
  workspaceId,
  projectId,
  textareaRef,
  setBody,
}: {
  workspaceId: string;
  projectId: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  setBody: (update: (body: string) => string) => void;
}) {
  const images = useHelpImageUpload(workspaceId, projectId);
  const [pending, setPending] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);

  const uploadInto = async (file: File, placeholder: string) => {
    const contentType = helpImageTypeOf(file.type);
    let url: string | null = null;
    let problem: string | null = null;
    try {
      url = contentType === undefined ? null : await images.upload(file, contentType, file.name);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    const markdown = url === null ? '' : `![${altOf(file.name)}](${url})`;
    // A function, so a `$` in the URL is taken literally.
    // eslint-disable-next-line sonarjs/null-dereference -- body is a string, never null
    setBody(body => body.replace(placeholder, () => markdown));
    if (url === null) {
      const reason = problem === null ? '.' : `: ${problem}`;
      setProblems(previous => [...previous, `${file.name} couldn't be uploaded${reason}`]);
    }
    setPending(count => count - 1);
  };

  /** Upload the files and put each image where the cursor is. */
  const upload = async (files: readonly File[]) => {
    const refused = files.map(file => helpImageProblem(file)).filter(problem => problem !== null);
    const accepted = files.filter(file => helpImageProblem(file) === null);
    setProblems(refused);
    if (accepted.length === 0) {
      return;
    }
    const placeholders = accepted.map(file => placeholderOf(file.name, crypto.randomUUID().slice(0, 8)));
    const element = textareaRef.current;
    const start = element?.selectionStart ?? Number.MAX_SAFE_INTEGER;
    const end = element?.selectionEnd ?? start;
    setBody(body => insertBlock(body, start, end, placeholders.join('\n\n')));
    setPending(count => count + accepted.length);
    // One at a time: the order they land in is the order they were added.
    // eslint-disable-next-line no-restricted-syntax -- sequential uploads, see above
    for (const [index, file] of accepted.entries()) {
      // eslint-disable-next-line no-await-in-loop -- sequential uploads, see above
      await uploadInto(file, placeholders[index] ?? '');
    }
  };

  /** Upload failures are shown per file, so nothing is left to await. */
  const add = (files: readonly File[]) => {
    fireAndForget(upload(files));
  };

  /** A paste with files uploads them; a paste of text stays a normal paste. */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesOf(event.clipboardData);
    if (files.length > 0) {
      event.preventDefault();
      add(files);
    }
  };

  const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
    const files = filesOf(event.dataTransfer);
    if (files.length > 0) {
      event.preventDefault();
      add(files);
    }
  };

  return {
    add,
    onPaste,
    onDragOver,
    onDrop,
    pending,
    problems,
    dismiss: () => {
      setProblems([]);
    },
  };
}
