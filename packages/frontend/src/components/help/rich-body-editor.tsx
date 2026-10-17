// The help article's rich editor (#486): editorcn's block editor (slash commands, drag handles,
// a bubble menu) over the article's Markdown. It loads the Markdown, and only after a real edit
// hands Markdown back, so opening an article never rewrites it. Images pasted, dropped or picked
// upload to the help center's storage and land as image nodes, `![name](public URL)` once saved.
import { HELP_IMAGE_TYPES } from '@mocco/common/help';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { ImageIcon, TableIcon } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, useState } from 'react';

import {
  BlockEditor,
  CodeBlock,
  defaultSlashCommandItems,
  getSlashCommandSuggestion,
  SlashCommand,
} from '@frontend/components/block-editor';
import { helpImageProblem, helpImageTypeOf, useHelpImageUpload } from '@frontend/components/help/use-help-image-upload';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { helpMediaExtensions, helpStarterKitOptions, withLeanTextEncoding } from '@frontend/lib/help-rich-markdown';

import type { SlashCommandSuggestionItem } from '@frontend/components/block-editor';
import type { EditorView } from '@tiptap/pm/view';
import type { Ref } from 'react';

/** What the article editor can ask of the rich editor: add images where the cursor is. */
export interface RichBodyEditorHandle {
  addImages: (files: readonly File[]) => void;
}

interface Props {
  workspaceId: string;
  projectId: string;
  initialMarkdown: string;
  /** The article's Markdown after each edit (never called just for opening it). */
  onChange: (markdown: string) => void;
  /** How many images are still uploading, so the draft doesn't save a half-built article. */
  onPendingChange: (pending: number) => void;
  /** Files refused or failed, one message each. */
  onProblems: (problems: string[]) => void;
  ref?: Ref<RichBodyEditorHandle>;
}

/** The slash menu's Image item asks for the file picker with this event on the editor's element. */
const PICK_IMAGE_EVENT = 'mocco-help-pick-image';

/** The image's alt text: its file name without the extension. */
// eslint-disable-next-line sonarjs/null-dereference -- filename is a string, never null
const altOf = (filename: string) => filename.replace(/\.[a-z0-9]+$/iu, '');

/** The files in a paste or drop, if any. */
const filesOf = (data: DataTransfer | null): File[] => (data === null ? [] : [...data.files]);

/** Put an image where the selection is, unless the editor has gone away meanwhile. */
function insertImage(view: EditorView, src: string, alt: string) {
  const node = view.isDestroyed ? undefined : view.state.schema.nodes.image?.create({ src, alt });
  if (node !== undefined) {
    view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
  }
}

/** editorcn's slash menu items, then an uploaded image and a table. */
const slashCommandItems: SlashCommandSuggestionItem[] = [
  ...defaultSlashCommandItems,
  {
    id: 'image',
    title: 'Image',
    description: 'Upload a PNG, JPEG, WebP or GIF.',
    keywords: ['image', 'picture', 'photo', 'screenshot'],
    icon: <ImageIcon />,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      editor.view.dom.dispatchEvent(new CustomEvent(PICK_IMAGE_EVENT, { bubbles: true }));
    },
  },
  {
    id: 'table',
    title: 'Table',
    description: 'A table with a header row.',
    keywords: ['table', 'grid'],
    icon: <TableIcon />,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    },
  },
];

/** Whether an item answers what was typed after "/": its title (so "/heading 2" finds Heading 2)
 * or the start of a keyword. */
const matches = (item: SlashCommandSuggestionItem, query: string) => {
  /* eslint-disable sonarjs/null-dereference -- the query, titles and keywords are strings, never null */
  const typed = query.trim().toLowerCase();
  return item.title.toLowerCase().includes(typed) || item.keywords.some(keyword => keyword.startsWith(typed));
  /* eslint-enable sonarjs/null-dereference */
};

/** editorcn's menu, also matching titles and with spaces allowed, so "/heading 2" works. */
const slashItems = {
  ...getSlashCommandSuggestion(slashCommandItems),
  allowSpaces: true,
  items: ({ query }: { query: string }) => slashCommandItems.filter(item => matches(item, query)),
};

export default function RichBodyEditor({
  workspaceId,
  projectId,
  initialMarkdown,
  onChange,
  onPendingChange,
  onProblems,
  ref,
}: Props) {
  const uploads = useHelpImageUpload(workspaceId, projectId);
  const [pending, setPending] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onPendingChange(pending);
  }, [pending, onPendingChange]);

  /** Upload the files one at a time and insert each image at the cursor as it finishes. */
  const upload = async (view: EditorView, files: readonly File[]) => {
    const accepted = files.filter(file => helpImageProblem(file) === null);
    onProblems(files.map(file => helpImageProblem(file)).filter(problem => problem !== null));
    setPending(count => count + accepted.length);
    // eslint-disable-next-line no-restricted-syntax -- sequential uploads keep the order they were added in
    for (const file of accepted) {
      const contentType = helpImageTypeOf(file.type);
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential uploads, see above
        const url = contentType === undefined ? null : await uploads.upload(file, contentType, file.name);
        if (url !== null) {
          insertImage(view, url, altOf(file.name));
        }
      } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : '.';
        onProblems([`${file.name} couldn't be uploaded${reason}`]);
      }
      setPending(count => count - 1);
    }
  };

  /** Upload pasted or dropped files; false lets the editor handle a paste or drop without files. */
  const take = (view: EditorView, files: readonly File[]) => {
    if (files.length === 0) {
      return false;
    }
    fireAndForget(upload(view, files));
    return true;
  };

  const editor = useEditor({
    // The console renders on the client only, so there is nothing to hydrate.
    immediatelyRender: false,
    extensions: [
      // The block editor's code block (syntax highlighting) replaces StarterKit's; no language
      // unless one is set, so a plain fence stays plain.
      StarterKit.configure({ ...helpStarterKitOptions, codeBlock: false }),
      ...helpMediaExtensions,
      CodeBlock.configure({ defaultLanguage: null }),
      Placeholder.configure({ placeholder: "Write, or type '/' for headings, lists, images and more…" }),
      SlashCommand.configure({ suggestion: slashItems }),
      Markdown,
    ],
    content: initialMarkdown,
    contentType: 'markdown',
    onCreate: ({ editor: created }) => {
      if (created.markdown !== undefined) {
        withLeanTextEncoding(created.markdown);
      }
    },
    // Only a change to the document (not a selection, not opening it) counts as an edit.
    onUpdate: ({ editor: changed }) => {
      onChange(changed.getMarkdown());
    },
    editorProps: {
      attributes: { 'aria-label': 'Article', class: 'help-article-body' },
      handlePaste: (view, event) => take(view, filesOf(event.clipboardData)),
      handleDrop: (view, event) => take(view, filesOf(event.dataTransfer)),
    },
  });

  // The slash menu's Image item opens the file picker.
  useEffect(() => {
    const container = containerRef.current;
    const open = () => {
      pickerRef.current?.click();
    };
    container?.addEventListener(PICK_IMAGE_EVENT, open);
    return () => {
      container?.removeEventListener(PICK_IMAGE_EVENT, open);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    addImages: files => {
      if (editor !== null) {
        take(editor.view, files);
      }
    },
  }));

  return (
    <div ref={containerRef}>
      <BlockEditor editor={editor} className="min-h-[28rem] rounded-xl border border-border px-2 py-3" />
      <input
        ref={pickerRef}
        type="file"
        accept={HELP_IMAGE_TYPES.join(',')}
        multiple
        hidden
        aria-label="Image files for the editor"
        onChange={event => {
          const input = event.currentTarget;
          if (editor !== null) {
            take(editor.view, [...(input.files ?? [])]);
          }
          // Picking the same file again should upload it again.
          input.value = '';
        }}
      />
    </div>
  );
}
