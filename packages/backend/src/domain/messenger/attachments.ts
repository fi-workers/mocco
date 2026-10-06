// Messenger attachments over object storage: reserving an upload, verifying and claiming
// what was uploaded, and short-lived links for messages' attachments. A contact (from the
// app) and a team member (from the inbox) go through the same functions, so the types,
// the 10 MB limit, the byte checks and the claim rules are one code path. Images are links a client may show
// inline; anything else (a PDF) is only ever served as a download, so a browser never
// renders a file that can carry script on Mocco's or the bucket's origin.
import { isImageAttachment } from '@mocco/common/messenger';
import { Products } from '@mocco/common/project';
import { Visibilities } from '@mocco/common/storage';

import {
  AttachmentContentMismatchError,
  AttachmentNotFoundError,
  AttachmentsUnavailableError,
} from '@backend/domain/messenger/errors';
import { MessengerAttachmentRepo } from '@backend/domain/messenger/repos/attachment.repo';
import { sniffContentType } from '@backend/domain/storage/content-bytes';
import { StoredObjectNotFoundError } from '@backend/domain/storage/errors';

import type { AttachmentRow } from '@backend/domain/messenger/repos/attachment.repo';
import type { ContactRow } from '@backend/domain/messenger/repos/contact.repo';
import type { StorageService } from '@backend/domain/storage/StorageService';
import type { Db } from '@backend/infra/db/types';
import type { AttachmentCreateInput, AttachmentDto } from '@mocco/common/messenger';

/** The storage the messenger uses; absent on a deploy without object storage. */
export type AttachmentStorage = Pick<StorageService, 'beginUpload' | 'completeUpload' | 'download' | 'read' | 'delete'>;

/** The contact an attachment is reserved for, which pins it to their workspace and project. */
export type AttachmentScope = Pick<ContactRow, 'workspaceId' | 'projectId'> & { contactId: string };

/** Every attachment is a private messenger object of the contact's project. */
export const attachmentOwnerOf = (scope: Pick<ContactRow, 'projectId'>) => ({
  projectId: scope.projectId,
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
  contact: Pick<ContactRow, 'workspaceId' | 'projectId'>,
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

/**
 * Reserve an upload for a screenshot or a PDF for `scope`'s contact. `uploadedBy` is the
 * team member uploading from the inbox, or absent for the contact. The storage policy
 * refuses another type or more than 10 MB.
 */
export async function reserveAttachment(
  db: Db,
  storage: AttachmentStorage | undefined,
  scope: AttachmentScope,
  input: AttachmentCreateInput,
  uploadedBy?: string,
) {
  if (storage === undefined) {
    throw new AttachmentsUnavailableError();
  }
  const { object, upload } = await storage.beginUpload({
    workspaceId: scope.workspaceId,
    ...attachmentOwnerOf(scope),
    filename: input.filename ?? (isImageAttachment(input.contentType) ? 'screenshot' : 'document.pdf'),
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    ...(uploadedBy !== undefined && { createdByUserId: uploadedBy }),
  });
  const attachment = await new MessengerAttachmentRepo(db).insert({
    workspaceId: scope.workspaceId,
    contactId: scope.contactId,
    objectId: object.id,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });
  return { attachmentId: attachment.id, upload };
}

/**
 * The ids, verified: unclaimed attachments reserved for `scope`'s contact by `uploadedBy`
 * (a team member's id, or null for the contact), each with its bytes uploaded as
 * declared (storage checks size and type, then the bytes' signature). Throws on any
 * other id. An attachment belongs to its uploader until a message claims it, and then to
 * that message's conversation only.
 */
export async function prepareAttachments(
  db: Db,
  storage: AttachmentStorage | undefined,
  scope: AttachmentScope,
  uploadedBy: string | null,
  ids: readonly string[] | undefined,
): Promise<string[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) {
    return [];
  }
  if (storage === undefined) {
    throw new AttachmentsUnavailableError();
  }
  const rows = await new MessengerAttachmentRepo(db).findUnclaimed(
    scope.workspaceId,
    scope.contactId,
    wanted,
    uploadedBy,
  );
  if (rows.length !== wanted.length) {
    throw new AttachmentNotFoundError();
  }
  await Promise.all(rows.map(async row => await verifyAttachment(db, storage, scope, row)));
  return wanted;
}

/** Claim every one of `ids` for the message, or throw (rolling the message back) when a
 * concurrent send claimed one first. Call in the message's transaction. */
export async function claimAttachments(tx: Db, ids: readonly string[], messageId: string): Promise<void> {
  if ((await new MessengerAttachmentRepo(tx).claim(ids, messageId)) !== ids.length) {
    throw new AttachmentNotFoundError();
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
