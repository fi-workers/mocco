import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'neutral' | 'secondary' | 'ghost';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** Shows a spinner, sets aria-busy, and disables — the "processing" affordance. */
  pending?: boolean;
  children: ReactNode;
}

// Colour per variant; size/width/text-size come from the caller's className so
// each call site keeps its layout (h-10, flex-1, text-xs, …).
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-violet-600 text-white hover:bg-violet-700 active:bg-violet-800',
  neutral: 'bg-neutral-900 text-white hover:bg-neutral-800 active:bg-neutral-950',
  secondary: 'border border-neutral-200 text-neutral-700 hover:bg-neutral-50 active:bg-neutral-100',
  ghost: 'text-violet-700 hover:text-violet-900 active:text-violet-950',
};

// active:scale gives the press-down feel; focus-visible ring for keyboard; the
// transition covers both. disabled kills pointer events so pressed/hover can't stick.
const BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition duration-100 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50';

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export default function Button({
  variant = 'primary',
  pending = false,
  disabled,
  className = '',
  type = 'button',
  children,
  ...props
}: Props) {
  return (
    <button
      type={type}
      disabled={disabled || pending}
      aria-busy={pending}
      className={`${BASE} ${VARIANTS[variant]} ${className}`}
      {...props}>
      {pending && <Spinner />}
      {children}
    </button>
  );
}
