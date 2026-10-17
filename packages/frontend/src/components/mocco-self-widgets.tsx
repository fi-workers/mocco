import { selfApiUrlOf } from '@mocco/common/mocco-self';
import { MessageSquarePlusIcon, SparklesIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Configure } from '@frontend/lib/configure';
import { fireAndForget } from '@frontend/lib/fire-and-forget';

import type { SelfWidgetsConfig } from '@mocco/common/mocco-self';
import type { ReactNode } from 'react';

// Mocco on Mocco (docs/reference/mocco-on-mocco.md): the console's "What's new" badge and
// "Feedback" sheet are @mocco/js widgets on a Mocco project, the same ones customers put in their
// apps. They load after the console: "What's new" when the browser is idle (its badge needs the
// count), the sheet on first hover, focus or click. Neither is in the console's own bundle, and
// without NEXT_PUBLIC_MOCCO_SELF_PUBLISHABLE_KEY and _BOARD nothing renders or loads.

type MountOn = (button: HTMLElement) => Promise<() => void>;

/** The widgets' options; the token fetcher loads with the widget's code. */
async function widgetOptions(config: SelfWidgetsConfig) {
  const { selfEndUserToken } = await import('@frontend/lib/mocco-self-token');
  return {
    publishableKey: config.publishableKey,
    board: config.board,
    baseUrl: selfApiUrlOf(config, document.location.origin),
    endUserToken: selfEndUserToken,
  };
}

/** Run `run` once the browser is idle (or soon, where there is no requestIdleCallback). */
function whenIdle(run: () => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(run, { timeout: 3000 });
    return () => {
      cancelIdleCallback(handle);
    };
  }
  const handle = setTimeout(run, 1500);
  return () => {
    clearTimeout(handle);
  };
}

/**
 * One widget on one button: loads its code once, mounts it, and when the user pressed the button
 * before it loaded, opens it then. A detach (unmount, or React's dev double effect) drops a load
 * still in flight.
 */
class LazyWidget {
  private button: HTMLElement | null = null;

  private generation = 0;

  private loadingGeneration: number | undefined;

  private unmount: (() => void) | undefined;

  private shouldOpen = false;

  constructor(private readonly mountOn: MountOn) {}

  get isMounted(): boolean {
    return this.unmount !== undefined;
  }

  attach(button: HTMLElement): void {
    this.button = button;
    this.generation += 1;
  }

  detach(): void {
    this.generation += 1;
    this.unmount?.();
    this.unmount = undefined;
    this.loadingGeneration = undefined;
    this.button = null;
    this.shouldOpen = false;
  }

  async load({ open }: { open: boolean }): Promise<void> {
    this.shouldOpen ||= open;
    const { button, generation } = this;
    if (button === null || this.isMounted || this.loadingGeneration === generation) {
      return;
    }
    this.loadingGeneration = generation;
    let unmount: () => void;
    try {
      unmount = await this.mountOn(button);
    } catch {
      // A failed chunk load (offline, a new deploy): the next press tries again.
      this.loadingGeneration = undefined;
      return;
    }
    if (generation !== this.generation) {
      unmount();
      return;
    }
    this.loadingGeneration = undefined;
    this.unmount = unmount;
    if (this.shouldOpen) {
      this.shouldOpen = false;
      // The widget now listens on the button; this press opens it.
      button.click();
    }
  }
}

function useLazyWidget(mountOn: MountOn, { onIdle }: { onIdle: boolean }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [widget] = useState(() => new LazyWidget(mountOn));

  useEffect(() => {
    const button = ref.current;
    if (button === null) {
      return undefined;
    }
    widget.attach(button);
    const cancelIdle = onIdle
      ? whenIdle(() => {
          fireAndForget(widget.load({ open: false }));
        })
      : undefined;
    return () => {
      cancelIdle?.();
      widget.detach();
    };
  }, [widget, onIdle]);

  const prefetch = () => {
    fireAndForget(widget.load({ open: false }));
  };
  return {
    ref,
    onPointerEnter: prefetch,
    onFocus: prefetch,
    // Once mounted, the widget's own listener handles the press.
    onClick: () => {
      if (!widget.isMounted) {
        fireAndForget(widget.load({ open: true }));
      }
    },
  };
}

const buttonClassName =
  'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-sm font-medium transition-colors outline-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted [&_svg]:size-4 [&_svg]:shrink-0';

function HeaderButton({
  icon,
  label,
  ...props
}: { icon: ReactNode; label: string } & ReturnType<typeof useLazyWidget>) {
  return (
    <button type="button" className={buttonClassName} {...props}>
      {icon}
      {/* Small screens show the icon only; the label stays for screen readers. */}
      <span className="sr-only sm:not-sr-only">{label}</span>
    </button>
  );
}

// The widgets' loaders stay outside components: React Compiler can't compile `import()`.
const whatsNewOn =
  (config: SelfWidgetsConfig): MountOn =>
  async button => {
    const [{ createWhatsNew }, options] = await Promise.all([import('@mocco/js/whats-new'), widgetOptions(config)]);
    return createWhatsNew(options).mount(button);
  };

const feedbackSheetOn =
  (config: SelfWidgetsConfig): MountOn =>
  async button => {
    const [{ createFeedbackSheet }, options] = await Promise.all([
      import('@mocco/js/feedback-sheet'),
      widgetOptions(config),
    ]);
    return createFeedbackSheet(options).mount(button, { labels: { title: 'Feedback' } });
  };

function SelfWidgets({ config }: { config: SelfWidgetsConfig }) {
  const whatsNew = useLazyWidget(whatsNewOn(config), { onIdle: true });
  const feedback = useLazyWidget(feedbackSheetOn(config), { onIdle: false });
  return (
    <>
      <HeaderButton icon={<SparklesIcon aria-hidden="true" />} label="What's new" {...whatsNew} />
      <HeaderButton icon={<MessageSquarePlusIcon aria-hidden="true" />} label="Feedback" {...feedback} />
    </>
  );
}

/** The console's own "What's new" and "Feedback" buttons, or nothing when not configured. */
export default function MoccoSelfWidgets() {
  const config = Configure.SelfWidgets;
  return config === null ? null : <SelfWidgets config={config} />;
}
