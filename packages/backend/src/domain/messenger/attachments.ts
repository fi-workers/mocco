// Messenger attachments over object storage: download links for messages' attachments.
import { MessengerAttachmentRepo } from '@backend/domain/messenger/repos/attachment.repo';

import type { StorageService } from '@backend/domain/storage/StorageService';
import type { Db } from '@backend/infra/db/types';
import type { AttachmentDto } from '@mocco/common/messenger';

/** The storage the messenger uses; absent on a deploy without object storage. */
export type AttachmentStorage = Pick<StorageService, 'beginUpload' | 'completeUpload' | 'downloadUrl'>;

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
    rows.map(async row => ({
      messageId: row.messageId ?? '',
      attachment: {
        id: row.id,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        url: await storage.downloadUrl(workspaceId, row.objectId, ATTACHMENT_URL_TTL_SECONDS),
      },
    })),
  );
  return served.reduce((map, { messageId, attachment }) => {
    map.set(messageId, [...(map.get(messageId) ?? []), attachment]);
    return map;
  }, byMessage);
}
