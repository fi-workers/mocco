// Images in help articles (#96, #208): pasted or picked in the editor, or brought in by an
// import. They go straight to object storage as public objects of the project's help
// center (two-phase: reserve, PUT, complete), and the article's Markdown refers to their
// stable public URL. The help center's storage policy decides what may be stored
// (PNG, JPEG, WebP, GIF; 10 MB); completing also reads the bytes, so a file that only
// claims to be an image is deleted, not served.

import { Products } from '@mocco/common/project';
import { Visibilities } from '@mocco/common/storage';

import { HelpImageNotAnImageError, HelpStorageNotConfiguredError } from '@backend/domain/helpcenter/errors';
import { sniffContentType } from '@backend/domain/storage/content-bytes';

import type { HelpSiteService } from '@backend/domain/helpcenter/HelpSiteService';
import type { ObjectOwner, StorageService } from '@backend/domain/storage/StorageService';
import type { HelpImageInput } from '@mocco/common/help';

export type HelpImageStorage = Pick<
  StorageService,
  'beginUpload' | 'completeUpload' | 'downloadUrl' | 'findReady' | 'read' | 'delete'
>;

export interface HelpImageDeps {
  sites: Pick<HelpSiteService, 'require'>;
  /** Object storage for article images; without it, image uploads are refused. */
  storage?: HelpImageStorage;
}

/** Every help image is a public object of its project's help center. */
const ownerOf = (projectId: string) =>
  ({
    projectId,
    product: Products.helpcenter,
    visibility: Visibilities.public,
  }) satisfies ObjectOwner;

export class HelpImageService {
  constructor(private readonly deps: HelpImageDeps) {}

  private requireStorage(): HelpImageStorage {
    if (this.deps.storage === undefined) {
      throw new HelpStorageNotConfiguredError();
    }
    return this.deps.storage;
  }

  /**
   * Reserve a public upload for an article image: PUT the bytes, then call
   * `completeImage`. An image the project already stored (same sha256) comes back as its
   * `url` instead, with nothing to upload.
   */
  async createImageUpload(
    workspaceId: string,
    projectId: string,
    actorUserId: string,
    input: HelpImageInput,
  ): Promise<
    { url: string } | { objectId: string; upload: Awaited<ReturnType<HelpImageStorage['beginUpload']>>['upload'] }
  > {
    await this.deps.sites.require(workspaceId, projectId);
    const storage = this.requireStorage();
    if (input.sha256 !== undefined) {
      const stored = await storage.findReady({ workspaceId, ...ownerOf(projectId), sha256: input.sha256 });
      if (stored !== undefined) {
        return { url: await storage.downloadUrl(workspaceId, stored.id) };
      }
    }
    const { object, upload } = await storage.beginUpload({
      workspaceId,
      ...ownerOf(projectId),
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      createdByUserId: actorUserId,
      ...(input.sha256 !== undefined && { sha256: input.sha256 }),
    });
    return { objectId: object.id, upload };
  }

  /**
   * Verify an uploaded image and return its stable public URL. Only an upload this
   * project's help center reserved can be completed here; bytes that aren't the declared
   * image type are deleted and refused.
   */
  async completeImage(workspaceId: string, projectId: string, objectId: string): Promise<{ url: string }> {
    await this.deps.sites.require(workspaceId, projectId);
    const storage = this.requireStorage();
    const object = await storage.completeUpload(workspaceId, objectId, ownerOf(projectId));
    const bytes = await storage.read(workspaceId, objectId);
    if (bytes === null || sniffContentType(bytes) !== object.contentType) {
      await storage.delete(workspaceId, objectId);
      throw new HelpImageNotAnImageError(object.contentType);
    }
    return { url: await storage.downloadUrl(workspaceId, objectId) };
  }
}
