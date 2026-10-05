// "Was this helpful?" under a public help article (#216). The answer goes to
// /api/help/feedback with a random visitor id this browser keeps, so changing one's mind
// the same day replaces the answer instead of adding one. Mocco stores only a keyed hash
// of the id.
import { useState } from 'react';

import type { HelpSiteWords } from '@frontend/lib/help-site-words';

const VISITOR_KEY = 'mocco-help-visitor';

/** This browser's visitor id, made on first use; undefined when storage is unavailable. */
function visitorId(): string | undefined {
  try {
    const kept = localStorage.getItem(VISITOR_KEY);
    if (kept !== null) {
      return kept;
    }
    // getRandomValues, unlike randomUUID, works outside secure contexts (a plain-http site).
    const made = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
      // eslint-disable-next-line sonarjs/null-dereference -- a Uint8Array yields numbers, never null
      byte.toString(16).padStart(2, '0'),
    ).join('');
    localStorage.setItem(VISITOR_KEY, made);
    return made;
  } catch {
    // Private mode or storage off: the server falls back to a per-day network key.
    return undefined;
  }
}

interface Props {
  site: string;
  article: string;
  locale: string;
  words: HelpSiteWords;
}

export default function HelpfulWidget({ site, article, locale, words }: Props) {
  const [answer, setAnswer] = useState<boolean | null>(null);

  const send = async (isHelpful: boolean) => {
    setAnswer(isHelpful);
    const visitor = visitorId();
    try {
      await fetch('/api/help/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          site,
          article,
          locale,
          helpful: isHelpful,
          ...(visitor !== undefined && { visitorId: visitor }),
        }),
      });
    } catch {
      // Offline: the reader still sees their answer; nothing is retried.
    }
  };

  return (
    <aside
      aria-label={words.wasHelpful}
      className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-4 text-sm">
      <span className="font-medium">{words.wasHelpful}</span>
      {[true, false].map(helpful => (
        <button
          key={String(helpful)}
          type="button"
          aria-pressed={answer === helpful}
          onClick={() => {
            // eslint-disable-next-line no-void -- a click handler can't await; send() never rejects
            void send(helpful);
          }}
          className="h-8 rounded-md border border-border px-3 hover:bg-muted aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background">
          {helpful ? words.yes : words.no}
        </button>
      ))}
      {answer === null ? null : (
        <span role="status" className="text-muted-foreground">
          {words.thanks}
        </span>
      )}
    </aside>
  );
}
