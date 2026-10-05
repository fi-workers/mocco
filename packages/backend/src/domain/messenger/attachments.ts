// Messenger attachments over object storage: verifying what a contact uploaded, and
// short-lived links for messages' attachments. Images are links a client may show
// inline; anything else (a PDF) is only ever served as a download, so a browser never
// renders a file that can carry script on Mocco's or the bucket's origin.
import { isImageAttachment } from '@mocco/common/messenger';
import { Products } from '@mocco/common/project';
import { Visibilities } from '@mocco/common/storage';

import { AttachmentContentMismatchError, AttachmentNotFoundError } from '@backend/domain/messenger/errors';
import { MessengerAttachmentRepo } from '@backend/domain/messenger/repos/attachment.repo';
import { sniffContentType } from '@backend/domain/storage/content-bytes';
import { StoredObjectNotFoundError } from '@backend/domain/storage/errors';

import type { AttachmentRow } from '@backend/domain/messenger/repos/attachment.repo';
import type { ContactRow } from '@backend/domain/messenger/repos/contact.repo';
import type { StorageService } from '@backend/domain/storage/StorageService';
import type { Db } from '@backend/infra/db/types';
import type { AttachmentDto } from '@mocco/common/messenger';

/** The storage the messenger uses; absent on a deploy without object storage. */
export type AttachmentStorage = Pick<StorageService, 'beginUpload' | 'completeUpload' | 'download' | 'read' | 'delete'>;

/** Every attachment is a private messenger object of the contact's project. */
export const attachmentOwnerOf = (contact: ContactRow) => ({
  projectId: contact.projectId,
  product: Products.messenger,
  visibility: Visibilities.private,
});

/**
 * Verify one uploaded attachment: storage checks the bytes exist with the declared size
 * and type (an object of another project or product is not found), then the bytes'
 * signature must be the declared type. A mismatch deletes the bytes and the attachment
 * and throws, so a file that only claims to be a PNG or a PDF is never served.
 */
export async function verifyAttachment(
  db: Db,
  storage: AttachmentStorage,
  contact: ContactRow,
  row: AttachmentRow,
): Promise<void> {
  try {
    await storage.completeUpload(contact.workspaceId, row.objectId, attachmentOwnerOf(contact));
  } catch (error) {
    // Collected by storage's gc (pending too long), or deleted: the attachment is gone.
    if (error instanceof StoredObjectNotFoundError) {
      throw new AttachmentNotFoundError({ cause: error });
    }
    throw error;
  }
  const bytes = await storage.read(contact.workspaceId, row.objectId);
  const sniffed = bytes === null ? null : sniffContentType(bytes);
  if (sniffed !== row.contentType) {
    await storage.delete(contact.workspaceId, row.objectId);
    await new MessengerAttachmentRepo(db).delete(contact.workspaceId, [row.id]);
    throw new AttachmentContentMismatchError(row.contentType);
  }
}

/** How long a served attachment link works. */
export const ATTACHMENT_URL_TTL_SECONDS = 10 * 60;

/** Each message's attachments, with short-lived download links. */
export async function attachmentsByMessage(
  db: Db,
  storage: AttachmentStorage | undefined,
  workspaceId: string,
  messageIds: readonly string[],
): Promise<Map<string, AttachmentDto[]>> {
  const byMessage = new Map<string, AttachmentDto[]>();
  if (storage === undefined) {
    return byMessage;
  }
  const rows = await new MessengerAttachmentRepo(db).listForMessages(messageIds);
  const served = await Promise.all(
    rows.map(async row => {
      const { url, filename } = await storage.download(workspaceId, row.objectId, {
        expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
        asAttachment: !isImageAttachment(row.contentType),
      });
      return {
        messageId: row.messageId ?? '',
        attachment: { id: row.id, contentType: row.contentType, sizeBytes: row.sizeBytes, filename, url },
      };
    }),
  );
  return served.reduce((map, { messageId, attachment }) => {
    map.set(messageId, [...(map.get(messageId) ?? []), attachment]);
    return map;
  }, byMessage);
}
