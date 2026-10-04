import { Products } from '@mocco/common/project';

import { errorMessage, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { groupEntries, productCatalog, sectionGroupLabels } from '@frontend/lib/products';
import { trpc } from '@frontend/lib/trpc';

import type { Product } from '@mocco/common/project';

interface Props {
  workspaceId: string;
}

// Workspace → Products: which product lines this workspace uses, grouped by the job they
// do. Enabling one adds its screens to the nav at once (the nav reads the same
// `product.list` query). Deploy governance is always on; products without screens yet
// are named once, in a compact roadmap list, rather than as rows nobody can turn on.
export default function WorkspaceProducts({ workspaceId }: Props) {
  const utils = trpc.useUtils();
  const listQuery = trpc.product.list.useQuery({ workspaceId });
  const enabled = new Set(listQuery.data?.products);
  const onSettled = async () => {
    await utils.product.list.invalidate({ workspaceId });
  };
  const enable = trpc.product.enable.useMutation({ onSettled });
  const disable = trpc.product.disable.useMutation({ onSettled });
  const failure = errorMessage(enable.error ?? disable.error);
  const entries = Object.entries(productCatalog) as [Product, (typeof productCatalog)[Product]][];
  const comingSoon = entries.filter(([, entry]) => !entry.available);
  const sections = groupEntries(
    entries.filter(([, entry]) => entry.available).map(([product, entry]) => ({ product, ...entry })),
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Products</h1>
        <p className="text-sm text-muted-foreground">
          Turn on the Mocco products this workspace uses. They share its members, roles and audit log.
        </p>
      </div>
      {failure === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {sections.map(section => (
        <section key={section.group ?? 'other'} className="flex flex-col gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">
            {section.group === null ? 'Other' : sectionGroupLabels[section.group]}
          </h2>
          <ul className="flex flex-col gap-2">
            {section.entries.map(entry => {
              const isOn = enabled.has(entry.product);
              const isFixed = entry.product === Products.governance;
              const action = isOn ? disable : enable;
              return (
                <li
                  key={entry.product}
                  className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {entry.label}
                      {isOn ? <StatusBadge tone={Tones.ok}>On</StatusBadge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">{entry.description}</span>
                  </div>
                  {isFixed ? null : (
                    <Button
                      variant={isOn ? 'outline' : 'default'}
                      className="shrink-0 text-sm"
                      pending={action.isPending && action.variables?.product === entry.product}
                      onClick={() => {
                        action.mutate({ workspaceId, product: entry.product });
                      }}>
                      {isOn ? 'Turn off' : 'Turn on'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {comingSoon.length === 0 ? null : (
        <section className="flex flex-col gap-2 rounded-xl border border-dashed border-border px-4 py-3">
          <h2 className="text-xs font-medium text-muted-foreground">On the roadmap</h2>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {comingSoon.map(([product, entry]) => (
              <li key={product} className="text-sm text-muted-foreground" title={entry.description}>
                {entry.label}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
