// The bodies the CLI signs (OTA design §6.3): one Expo Updates manifest per platform,
// re-dated copies of channel heads for instant rollback, and a rollBackToEmbedded directive.
import type { ExportedFile, PlatformExport } from './expo-export';

const assetEntry = (file: ExportedFile, assetBaseUrl: string, fileExtension: string | null) => ({
  hash: file.hash,
  key: file.key,
  contentType: file.contentType,
  ...(fileExtension !== null && { fileExtension }),
  url: `${assetBaseUrl}/${file.hash}`,
});

export interface ManifestInput {
  id: string;
  createdAt: Date;
  runtimeVersion: string;
  assetBaseUrl: string;
  exported: PlatformExport;
  extra: Record<string, unknown>;
}

/** An Expo Updates protocol v1 manifest, as the exact JSON string to sign. */
export function buildManifest(input: ManifestInput): string {
  return JSON.stringify({
    id: input.id,
    createdAt: input.createdAt.toISOString(),
    runtimeVersion: input.runtimeVersion,
    launchAsset: assetEntry(input.exported.bundle, input.assetBaseUrl, '.bundle'),
    assets: input.exported.assets.map(asset =>
      assetEntry(asset, input.assetBaseUrl, asset.ext === null ? null : `.${asset.ext}`),
    ),
    metadata: {},
    extra: input.extra,
  });
}

/** A channel head's manifest with a new id and a later `createdAt`: devices on the new
 * release load it, which is how a rollback reaches them without a new signature. */
export function republishOf(manifest: string, id: string, createdAt: Date): string {
  const parsed = JSON.parse(manifest) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, id, createdAt: createdAt.toISOString() });
}

export function rollBackToEmbeddedOf(commitTime: Date): string {
  return JSON.stringify({ type: 'rollBackToEmbedded', parameters: { commitTime: commitTime.toISOString() } });
}
