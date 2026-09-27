import { CheckIcon, CopyIcon } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@frontend/components/ui/button';
import { fireAndForget } from '@frontend/lib/fire-and-forget';
import { cn } from '@frontend/lib/utils';

import type { ReactNode } from 'react';

// Small building blocks shared by the three Notifications tabs: status badges, a copy
// button, a notice box and time formatting.

export const inputClass =
  'h-8 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus:border-ring disabled:opacity-50';

export const labelClass = 'flex flex-col gap-1 text-xs font-medium text-muted-foreground';

export const Tones = {
  ok: 'ok',
  warn: 'warn',
  danger: 'danger',
  neutral: 'neutral',
} as const;
export type Tone = (typeof Tones)[keyof typeof Tones];

const toneClass: Record<Tone, string> = {
  [Tones.ok]:
    'border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-400',
  [Tones.warn]: 'border-amber-600/30 bg-amber-500/10 text-amber-700 dark:border-amber-400/30 dark:text-amber-400',
  [Tones.danger]: 'border-destructive/30 bg-destructive/10 text-destructive',
  [Tones.neutral]: 'border-border bg-muted text-muted-foreground',
};

/** A compact status pill with a dot, like the prototype's `.badge`. */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-xs font-medium whitespace-nowrap',
        toneClass[tone],
      )}>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}

/** A bordered message box. `danger` and `warn` are announced to screen readers. */
export function Notice({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  const isAlert = tone === Tones.danger || tone === Tones.warn;
  return (
    <div role={isAlert ? 'alert' : 'status'} className={cn('rounded-lg border px-3 py-2.5 text-sm', toneClass[tone])}>
      <p className="font-medium">{title}</p>
      {children === undefined ? null : <div className="mt-1 text-foreground/80">{children}</div>}
    </div>
  );
}

/** Copies `value` to the clipboard and confirms for a moment. */
function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        fireAndForget(copy());
      }}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** A read-only value with a copy button (ingest URLs, secrets). */
export function CopyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <input
        readOnly
        aria-label={label}
        value={value}
        className={cn(inputClass, 'min-w-0 flex-1 font-mono text-xs')}
        onFocus={event => {
          event.target.select();
        }}
      />
      <CopyButton value={value} />
    </div>
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "2 days ago"; the exact time is in the title. */
function formatAgo(date: Date, now = Date.now()): string {
  const elapsed = now - date.getTime();
  if (elapsed < MINUTE) {
    return 'just now';
  }
  if (elapsed < HOUR) {
    return `${Math.floor(elapsed / MINUTE)} min ago`;
  }
  if (elapsed < DAY) {
    return `${Math.floor(elapsed / HOUR)} h ago`;
  }
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** Days since `date` (whole days). */
export function daysSince(date: Date, now = Date.now()): number {
  return Math.floor((now - date.getTime()) / DAY);
}

/** A time element with a relative label and the exact time on hover. */
export function Ago({ date }: { date: Date }) {
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {formatAgo(date)}
    </time>
  );
}

/** The message of a failed tRPC call, for inline display. */
export function errorMessage(error: { message: string } | null): string | null {
  return error === null ? null : error.message;
}

export function Spinner() {
  return (
    <span
      role="status"
      aria-label="Loading"
      className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground"
    />
  );
}
