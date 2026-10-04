import Link from 'next/link';
import { useEffect, useRef } from 'react';

import { groupEntries, sectionGroupLabels } from '@frontend/lib/products';
import { cn } from '@frontend/lib/utils';

import type { SectionGroup } from '@frontend/lib/products';
import type { ReactNode } from 'react';

export interface SideNavItem {
  key: string;
  label: string;
  href: string;
  group: SectionGroup | null;
}

interface Props {
  /** Names what the sidebar is for (the workspace, or a project with a way back). */
  header: ReactNode;
  /** An accessible name for the nav landmark. */
  label: string;
  items: readonly SideNavItem[];
  activeKey: string;
  footer?: ReactNode;
  children: ReactNode;
}

// On a phone the nav is a horizontal strip that can be wider than the screen; centre the
// current section in it so the reader sees where they are without scrolling sideways.
// A no-op when the strip fits (and on wider screens, where the nav is a column).
function revealInStrip(link: HTMLElement | null): void {
  const strip = link?.closest('nav');
  if (!link || !strip || strip.scrollWidth <= strip.clientWidth) {
    return;
  }
  strip.scrollLeft = link.offsetLeft - (strip.clientWidth - link.offsetWidth) / 2;
}

// The sidebar frame shared by the workspace and project layouts: a grouped nav beside
// the page content. On narrow screens the nav becomes a scrollable strip above the
// content, without group headings, so no page overflows a phone's width.
export default function SideNavLayout({ header, label, items, activeKey, footer, children }: Props) {
  const navRef = useRef<HTMLElement>(null);
  // Items arrive as the enabled products load, so re-centre whenever the set changes.
  const itemKeys = items.map(item => item.key).join(' ');
  useEffect(() => {
    revealInStrip(navRef.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? null);
  }, [activeKey, itemKeys]);

  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-3 border-b border-border px-3 py-3 md:w-56 md:gap-4 md:border-r md:border-b-0 md:py-6">
        {header}
        <nav
          ref={navRef}
          aria-label={label}
          className="relative flex gap-0.5 overflow-x-auto md:flex-col md:gap-4 md:overflow-visible">
          {groupEntries(items).map(section => (
            <div key={section.group ?? 'top'} className="flex shrink-0 gap-0.5 md:flex-col">
              {section.group === null ? null : (
                <span className="hidden px-3 pb-1 text-xs font-medium text-muted-foreground md:block">
                  {sectionGroupLabels[section.group]}
                </span>
              )}
              {section.entries.map(item => (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={item.key === activeKey ? 'page' : undefined}
                  className={cn(
                    'shrink-0 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition md:py-1.5',
                    item.key === activeKey
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}>
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        {footer}
      </aside>
      <div className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-4xl">{children}</div>
      </div>
    </div>
  );
}
