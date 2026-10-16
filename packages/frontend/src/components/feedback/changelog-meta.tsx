// What a changelog entry is about (#176): its tags as badges and its date, shared by the
// changelog page and an entry's page.
import { ChangelogTags } from '@mocco/common/feedback';

import { cn } from '@frontend/lib/utils';

import type { ChangelogTag } from '@mocco/common/feedback';

const tagStyles: Record<ChangelogTag, { label: string; className: string }> = {
  [ChangelogTags.new]: {
    label: 'New',
    className: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
  },
  [ChangelogTags.improved]: {
    label: 'Improved',
    className: 'border-sky-600/30 bg-sky-600/10 text-sky-700 dark:text-sky-400',
  },
  [ChangelogTags.fixed]: {
    label: 'Fixed',
    className: 'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
};

export function ChangelogTagList({ tags }: { tags: readonly ChangelogTag[] }) {
  return (
    <>
      {tags.map(tag => (
        <span key={tag} className={cn('rounded-full border px-2 py-0.5 text-xs font-medium', tagStyles[tag].className)}>
          {tagStyles[tag].label}
        </span>
      ))}
    </>
  );
}

/** "October 16, 2026", in UTC so the server's and the browser's renders agree. */
export function formatChangelogDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
