// Markdown → the small render tree in lib/doc-ast.ts, for the customer guides and the
// public help center pages (in getStaticProps), and the help editor's live preview. The
// output is plain data rendered as React elements, never an HTML string; raw HTML in the
// Markdown renders as its text.
import { Lexer } from 'marked';

import type { DocBlock, DocInline } from '@frontend/lib/doc-ast';
import type { Token, Tokens } from 'marked';

/** Where links and images point; null drops the link (keeping its text) or shows the image's alt text. */
export interface MarkdownResolvers {
  link: (href: string) => { href: string; external: boolean } | null;
  image: (href: string, alt: string) => Extract<DocInline, { t: 'image' }> | null;
}

/** GitHub-style heading anchors, so `page.md#some-heading` links keep working. */
export function slugify(text: string): string {
  // eslint-disable-next-line sonarjs/null-dereference -- a heading's text, never null
  return text
    .toLowerCase()
    .trim()
    .replaceAll(/[^\p{L}\p{N}\s-]/gu, '')
    .replaceAll(/\s/gu, '-');
}

function plainText(tokens: readonly Token[]): string {
  return tokens
    .map(token => {
      const nested = (token as Tokens.Generic).tokens;
      return nested === undefined ? (((token as Tokens.Generic).text as string | undefined) ?? '') : plainText(nested);
    })
    .join('');
}

function inline(resolve: MarkdownResolvers, tokens: readonly Token[]): DocInline[] {
  return tokens.flatMap((token): DocInline[] => {
    switch (token.type) {
      case 'strong': {
        return [{ t: 'strong', c: inline(resolve, (token as Tokens.Strong).tokens) }];
      }
      case 'em': {
        return [{ t: 'em', c: inline(resolve, (token as Tokens.Em).tokens) }];
      }
      case 'codespan': {
        return [{ t: 'code', v: (token as Tokens.Codespan).text }];
      }
      case 'br': {
        return [{ t: 'br' }];
      }
      case 'link': {
        const link = token as Tokens.Link;
        const children = inline(resolve, link.tokens);
        const target = resolve.link(link.href);
        return target === null ? children : [{ t: 'link', ...target, c: children }];
      }
      case 'image': {
        const image = token as Tokens.Image;
        const resolved = resolve.image(image.href, image.text);
        return resolved === null ? [{ t: 'text', v: image.text }] : [resolved];
      }
      case 'text': {
        const text = token as Tokens.Text;
        return text.tokens === undefined ? [{ t: 'text', v: text.text }] : inline(resolve, text.tokens);
      }
      case 'escape': {
        return [{ t: 'text', v: (token as Tokens.Escape).text }];
      }
      default: {
        // html and anything else: its raw text, never markup.
        return [{ t: 'text', v: token.raw }];
      }
    }
  });
}

function blocks(resolve: MarkdownResolvers, tokens: readonly Token[]): DocBlock[] {
  return tokens.flatMap((token): DocBlock[] => {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        return [
          {
            t: 'heading',
            depth: heading.depth,
            id: slugify(plainText(heading.tokens)),
            c: inline(resolve, heading.tokens),
          },
        ];
      }
      case 'paragraph': {
        return [{ t: 'p', c: inline(resolve, (token as Tokens.Paragraph).tokens) }];
      }
      case 'text': {
        // A tight list item's text.
        const text = token as Tokens.Text;
        return [
          { t: 'p', c: text.tokens === undefined ? [{ t: 'text', v: text.text }] : inline(resolve, text.tokens) },
        ];
      }
      case 'list': {
        const list = token as Tokens.List;
        return [
          {
            t: 'list',
            ordered: list.ordered,
            start: list.start === '' ? 1 : list.start,
            items: list.items.map(item => blocks(resolve, item.tokens)),
          },
        ];
      }
      case 'code': {
        const code = token as Tokens.Code;
        return [{ t: 'code', lang: code.lang ?? '', v: code.text }];
      }
      case 'blockquote': {
        return [{ t: 'quote', c: blocks(resolve, (token as Tokens.Blockquote).tokens) }];
      }
      case 'table': {
        const table = token as Tokens.Table;
        return [
          {
            t: 'table',
            header: table.header.map(cell => inline(resolve, cell.tokens)),
            rows: table.rows.map(row => row.map(cell => inline(resolve, cell.tokens))),
          },
        ];
      }
      case 'hr': {
        return [{ t: 'hr' }];
      }
      default: {
        // space, html, def: nothing to render.
        return [];
      }
    }
  });
}

export function markdownToBlocks(markdown: string, resolve: MarkdownResolvers): DocBlock[] {
  return blocks(resolve, new Lexer({ gfm: true }).lex(markdown));
}
