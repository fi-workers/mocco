import { zodResolver } from '@hookform/resolvers/zod';
import { workspaceCreateInputSchema } from '@mocco/common/workspace';
import { useForm } from 'react-hook-form';

import Button from './button';

import type { WorkspaceCreateInput } from '@mocco/common/workspace';

interface Props {
  /** Performs the create/update — the same form backs both, only the action differs. */
  onSubmit: (values: WorkspaceCreateInput) => Promise<void>;
  defaultValues?: WorkspaceCreateInput;
  submitLabel?: string;
  onCancel?: () => void;
}

// react-hook-form + the shared @mocco/common zod schema, so client validation is
// the same schema the server enforces (single source of truth).
export default function WorkspaceForm({ onSubmit, defaultValues, submitLabel = 'Create workspace', onCancel }: Props) {
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<WorkspaceCreateInput>({
    resolver: zodResolver(workspaceCreateInputSchema),
    defaultValues: defaultValues ?? { name: '' },
  });

  const submit = handleSubmit(async values => {
    try {
      await onSubmit(values);
    } catch (error) {
      setError('root', { message: (error as Error).message });
    }
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
      <input
        {...register('name')}
        maxLength={80}
        placeholder="Workspace name"
        aria-label="Workspace name"
        className="h-10 rounded-lg border border-neutral-200 px-3 text-sm outline-none focus:border-violet-500"
      />
      {errors.name && <p className="text-sm text-red-600">{errors.name.message}</p>}
      {errors.root && <p className="text-sm text-red-600">{errors.root.message}</p>}
      <div className="flex gap-2">
        <Button type="submit" pending={isSubmitting} className="h-10 flex-1 text-sm">
          {isSubmitting ? 'Saving…' : submitLabel}
        </Button>
        {onCancel && (
          <Button variant="secondary" disabled={isSubmitting} onClick={onCancel} className="h-10 px-4 text-sm">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
