// Attaching images and PDFs to a reply from the inbox (#430): reserve each file in the
// conversation under the messenger's storage policy, PUT the bytes straight to storage,
// and hand back the ids for `messenger.write`. The server checks the type, the 10 MB
// limit and the bytes; the checks here only spare a round trip.
import { ATTACHMENT_CONTENT_TYPES, MessengerLimits } from '@mocco/common/messenger';

import { trpc } from '@frontend/lib/trpc';

import type { AttachmentContentType } from '@mocco/common/messenger';

/** The file's type when the messenger can send it. */
export function replyAttachmentTypeOf(type: string): AttachmentContentType | undefined {
  return ATTACHMENT_CONTENT_TYPES.find(allowed => allowed === type);
}

/** Why this file can't go with a reply, or null when it can. The server checks the same. */
export function replyAttachmentProblem(file: File): string | null {
  if (replyAttachmentTypeOf(file.type) === undefined) {
    return `${file.name} isn't a PNG, JPEG, WebP or GIF image, or a PDF.`;
  }
  if (file.size > MessengerLimits.attachmentMaxBytes) {
    return `${file.name} is over 10 MB.`;
  }
  return null;
}

export function useReplyAttachments(workspaceId: string, projectId: string, conversationId: string) {
  const reserve = trpc.messenger.createAttachment.useMutation();

  /** Upload one file; its attachment id. Throws when the server or storage refuses it. */
  const uploadOne = async (file: File): Promise<string> => {
    const contentType = replyAttachmentTypeOf(file.type);
    if (contentType === undefined) {
      throw new Error(replyAttachmentProblem(file) ?? `${file.name} can't be attached.`);
    }
    const { attachmentId, upload } = await reserve.mutateAsync({
      workspaceId,
      projectId,
      conversationId,
      contentType,
      sizeBytes: file.size,
      filename: file.name,
    });
    const response = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
    if (!response.ok) {
      throw new Error(`${file.name} didn't upload. Try again.`);
    }
    return attachmentId;
  };

  /** Upload every file; their attachment ids, in order. */
  const upload = async (files: readonly File[]): Promise<string[]> =>
    await Promise.all(files.map(async file => await uploadOne(file)));

  return { upload, isUploading: reserve.isPending };
}
