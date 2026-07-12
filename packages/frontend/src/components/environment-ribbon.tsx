// A small fixed ribbon marking non-production environments, so a preview or local
// tab is never mistaken for prod. Pattern borrowed from the checkable app.
// The value comes from Vercel's VERCEL_ENV, bridged to the client in next.config
// as NEXT_PUBLIC_VERCEL_ENV (empty off-Vercel → treated as local development).
const ENV = process.env.NEXT_PUBLIC_VERCEL_ENV || 'development';

const COLOR: Record<string, string> = {
  preview: 'bg-amber-500',
  development: 'bg-rose-500',
};

// eslint-disable-next-line sonarjs/function-return-type -- a React component may render an element or null
export default function EnvironmentRibbon() {
  if (ENV === 'production') return null;

  return (
    <div
      className={`fixed left-1/2 top-0 z-50 -translate-x-1/2 rounded-b-lg px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white ${COLOR[ENV] ?? 'bg-neutral-500'}`}>
      {ENV}
    </div>
  );
}
