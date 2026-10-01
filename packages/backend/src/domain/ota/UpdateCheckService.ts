import { selectResponse } from '@backend/domain/ota/serving/select';
import { headKeyOf } from '@backend/domain/ota/serving/state-cache';

import type { ChannelHeadRepo } from '@backend/domain/ota/repos/channel-head.repo';
import type { OtaAssetRepo } from '@backend/domain/ota/repos/ota-asset.repo';
import type { Selection } from '@backend/domain/ota/serving/select';
import type { ChannelStateCache } from '@backend/domain/ota/serving/state-cache';
import type { StorageService } from '@backend/domain/storage/StorageService';
import type { OtaPlatform } from '@mocco/common/ota-hosting';

export interface UpdateCheckServiceDeps {
  heads: Pick<ChannelHeadRepo, 'findServingState'>;
  assets: Pick<OtaAssetRepo, 'findVerifiedObject'>;
  storage: StorageService | undefined;
  cache: ChannelStateCache;
}

export interface UpdateCheck {
  appId: string;
  channel: string;
  platform: OtaPlatform;
  runtimeVersion: string;
  clientId: string | undefined;
  currentUpdateId: string | undefined;
}

/**
 * The device side of Mocco-hosted OTA (ADR 0021): which signed body a stock expo-updates
 * client gets for its channel, platform and runtime. Heads are cached for a few seconds,
 * including "nothing to serve", so a cache hit touches no database.
 */
export class UpdateCheckService {
  constructor(private readonly deps: UpdateCheckServiceDeps) {}

  async check(input: UpdateCheck): Promise<Selection> {
    const key = headKeyOf(input.appId, input.channel, input.platform, input.runtimeVersion);
    let head = this.deps.cache.get(key);
    if (head === undefined) {
      head =
        (await this.deps.heads.findServingState(input.appId, input.channel, input.platform, input.runtimeVersion)) ??
        null;
      this.deps.cache.set(key, head);
    }
    return selectResponse({
      head: head ?? undefined,
      clientId: input.clientId,
      currentUpdateId: input.currentUpdateId,
    });
  }

  /** Where a verified asset's bytes are (the store's public URL), or undefined. */
  async assetUrl(appId: string, hash: string): Promise<string | undefined> {
    const object = await this.deps.assets.findVerifiedObject(appId, hash);
    if (object === undefined || this.deps.storage === undefined) {
      return undefined;
    }
    return await this.deps.storage.downloadUrl(object.workspaceId, object.id);
  }
}
