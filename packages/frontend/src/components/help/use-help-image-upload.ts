// Uploading an image for a help article (#96, #208): reserve it under the help center's
// storage policy, PUT the bytes straight to storage, then complete it for its public URL.
// An image the project already stored (same SHA-256) comes back at once. Used by the
// article editor (paste, drop, pick) and the Mintlify import.

import { HELP_IMAGE_MAX_BYTES, HELP_IMAGE_TYPES } from '@mocco/common/help';

import { trpc } from '@frontend/lib/trpc';

import type { HelpImageType } from '@mocco/common/help';

/** The file's type when the help center can store it. */
export function helpImageTypeOf(type: string): HelpImageType | undefined {
  return HELP_IMAGE_TYPES.find(allowed => allowed === type);
}

/** Why this file can't be added to an article, or null when it can. The server checks the same. */
export function helpImageProblem(file: File): string | null {
  if (helpImageTypeOf(file.type) === undefined) {
    return `${file.name} isn't a PNG, JPEG, WebP or GIF image.`;
  }
  if (file.size > HELP_IMAGE_MAX_BYTES) {
    return `${file.name} is over 10 MB.`;
  }
  return null;
}

async function sha256Of(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  // eslint-disable-next-line sonarjs/null-dereference -- each byte is a number, never null
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function useHelpImageUpload(workspaceId: string, projectId: string) {
  const reserve = trpc.help.createImageUpload.useMutation();
  const complete = trpc.help.completeImage.useMutation();

  /** The image's public URL, or null when storage refused the bytes. Server refusals throw. */
  const upload = async (file: Blob, contentType: HelpImageType, filename: string): Promise<string | null> => {
    const reserved = await reserve.mutateAsync({
      workspaceId,
      projectId,
      contentType,
      sizeBytes: file.size,
      filename,
      sha256: await sha256Of(file),
    });
    if ('url' in reserved) {
      return reserved.url;
    }
    const { objectId, upload: target } = reserved;
    const response = await fetch(target.url, { method: target.method, headers: target.headers, body: file });
    if (!response.ok) {
      return null;
    }
    const { url } = await complete.mutateAsync({ workspaceId, projectId, objectId });
    return url;
  };

  return { upload, error: reserve.error ?? complete.error };
}
