import { Products } from '@mocco/common/project';

import { errorMessage, StatusBadge, Tones } from '@frontend/components/notifications/notification-ui';
import { Button } from '@frontend/components/ui/button';
import { productCatalog } from '@frontend/lib/products';
import { trpc } from '@frontend/lib/trpc';

import type { Product } from '@mocco/common/project';

interface Props {
  workspaceId: string;
}

// Workspace → Products: which product lines this workspace uses. Enabling one adds its
// screens to the nav at once (the nav reads the same `product.list` query). Deploy
// governance is always on; products without screens yet are listed as coming soon.
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Products</h1>
        <p className="text-sm text-muted-foreground">Turn on the Mocco products this workspace uses.</p>
      </div>
      {failure === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {entries.map(([product, entry]) => {
          const isOn = enabled.has(product);
          const isFixed = product === Products.governance;
          return (
            <li
              key={product}
              className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {entry.label}
                  {isOn ? <StatusBadge tone={Tones.ok}>On</StatusBadge> : null}
                  {entry.available ? null : <StatusBadge tone={Tones.neutral}>Coming soon</StatusBadge>}
                </span>
                <span className="text-xs text-muted-foreground">{entry.description}</span>
              </div>
              {isFixed || !entry.available ? null : (
                <Button
                  variant={isOn ? 'outline' : 'default'}
                  className="shrink-0 text-sm"
                  pending={
                    (isOn ? disable : enable).isPending && (isOn ? disable : enable).variables?.product === product
                  }
                  onClick={() => {
                    (isOn ? disable : enable).mutate({ workspaceId, product });
                  }}>
                  {isOn ? 'Turn off' : 'Turn on'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
