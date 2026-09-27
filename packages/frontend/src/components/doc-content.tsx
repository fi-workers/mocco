import Image from 'next/image';
import Link from 'next/link';

import type { DocBlock, DocInline } from '@frontend/lib/doc-ast';

// Renders a customer guide's tree (lib/doc-ast.ts) as React elements. Keys are the
// node's position: the tree is static per build, so positions are stable identities.
/* eslint-disable @eslint-react/no-array-index-key -- static, build-time trees: the index is the identity */

function Inline({ nodes }: { nodes: DocInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.t) {
          case 'text': {
            return <span key={index}>{node.v}</span>;
          }
          case 'strong': {
            return (
              <strong key={index} className="font-semibold text-foreground">
                <Inline nodes={node.c} />
              </strong>
            );
          }
          case 'em': {
            return (
              <em key={index}>
                <Inline nodes={node.c} />
              </em>
            );
          }
          case 'code': {
            return (
              <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">
                {node.v}
              </code>
            );
          }
          case 'br': {
            return <br key={index} />;
          }
          case 'link': {
            return node.external ? (
              <a
                key={index}
                href={node.href}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-2">
                <Inline nodes={node.c} />
              </a>
            ) : (
              <Link key={index} href={node.href} className="font-medium text-foreground underline underline-offset-2">
                <Inline nodes={node.c} />
              </Link>
            );
          }
          case 'image': {
            return (
              <Image
                key={index}
                src={node.src}
                alt={node.alt}
                width={node.width}
                height={node.height}
                sizes="(min-width: 1024px) 768px, 100vw"
                className="my-2 h-auto w-full rounded-xl border border-border shadow-sm"
              />
            );
          }
          default: {
            return null;
          }
        }
      })}
    </>
  );
}

const headingClass: Record<number, string> = {
  1: 'mb-2 text-3xl font-semibold tracking-tight text-foreground',
  2: 'mt-10 mb-1 border-t border-border pt-8 text-xl font-semibold tracking-tight text-foreground',
  3: 'mt-6 text-base font-semibold text-foreground',
};

function Heading({ depth, id, nodes }: { depth: number; id: string; nodes: DocInline[] }) {
  const className = headingClass[depth] ?? 'mt-4 text-sm font-semibold text-foreground';
  const content = <Inline nodes={nodes} />;
  if (depth === 1) {
    return (
      <h1 id={id} className={className}>
        {content}
      </h1>
    );
  }
  if (depth === 2) {
    return (
      <h2 id={id} className={className}>
        {content}
      </h2>
    );
  }
  if (depth === 3) {
    return (
      <h3 id={id} className={className}>
        {content}
      </h3>
    );
  }
  return (
    <h4 id={id} className={className}>
      {content}
    </h4>
  );
}

export default function DocContent({ blocks }: { blocks: DocBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.t) {
          case 'heading': {
            return <Heading key={index} depth={block.depth} id={block.id} nodes={block.c} />;
          }
          case 'p': {
            return (
              <p key={index} className="leading-7">
                <Inline nodes={block.c} />
              </p>
            );
          }
          case 'list': {
            const items = block.items.map((item, itemIndex) => (
              <li key={itemIndex} className="pl-1 [&>p]:leading-7">
                <DocContent blocks={item} />
              </li>
            ));
            return block.ordered ? (
              <ol key={index} start={block.start} className="flex list-decimal flex-col gap-1.5 pl-6">
                {items}
              </ol>
            ) : (
              <ul key={index} className="flex list-disc flex-col gap-1.5 pl-6">
                {items}
              </ul>
            );
          }
          case 'code': {
            return (
              <pre key={index} className="overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-xs leading-6">
                <code>{block.v}</code>
              </pre>
            );
          }
          case 'quote': {
            return (
              <blockquote
                key={index}
                className="flex flex-col gap-2 rounded-lg border border-amber-600/30 bg-amber-500/5 px-4 py-3 text-sm">
                <DocContent blocks={block.c} />
              </blockquote>
            );
          }
          case 'table': {
            return (
              <div key={index} className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} scope="col" className="px-3 py-2 font-medium">
                          <Inline nodes={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-border align-top last:border-b-0">
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="px-3 py-2">
                            <Inline nodes={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case 'hr': {
            return <hr key={index} className="border-border" />;
          }
          default: {
            return null;
          }
        }
      })}
    </>
  );
}
