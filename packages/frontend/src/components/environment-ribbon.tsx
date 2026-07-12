import { ENVIRONMENT, Environments } from '../lib/environment';

import type { Environment } from '../lib/environment';

// A small fixed ribbon marking non-production environments, so a preview or local
// tab is never mistaken for prod. Pattern borrowed from the checkable app.
const COLOR: Record<Environment, string> = {
  [Environments.Local]: 'bg-rose-500',
  [Environments.Dev]: 'bg-amber-500',
  [Environments.Prod]: 'bg-neutral-500',
};

// eslint-disable-next-line sonarjs/function-return-type -- a React component may render an element or null
export default function EnvironmentRibbon() {
  if (ENVIRONMENT === Environments.Prod) return null;

  return (
    <div
      className={`fixed left-1/2 top-0 z-50 -translate-x-1/2 rounded-b-lg px-3 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white ${COLOR[ENVIRONMENT]}`}>
      {ENVIRONMENT}
    </div>
  );
}
