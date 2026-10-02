import { createHash, randomBytes } from 'node:crypto';

import { AuditActions } from '@mocco/common/audit';
import {
  COMMIT_TIME_MAX_FUTURE_MS,
  COMMIT_TIME_MAX_PAST_MS,
  expoManifestSchema,
  OtaDirectiveTypes,
  OtaReleaseStatuses,
  OtaUpdateKinds,
  rollBackToEmbeddedDirectiveSchema,
  UPLOAD_SESSION_TTL_SECONDS,
} from '@mocco/common/ota-hosting';
import { Products } from '@mocco/common/project';
import { ObjectStatuses, Visibilities } from '@mocco/common/storage';

import { hashToken } from '@backend/domain/execution/callback-token';
import {
  OtaAppNotFoundError,
  OtaReleaseNotFoundError,
  OtaUploadConflictError,
  OtaUploadRejectedError,
} from '@backend/domain/ota/errors';
import { verifyOtaAssets } from '@backend/domain/ota/jobs';
import { serializeSignatureHeader } from '@backend/domain/ota/manifest/signature';
import { SignatureRefusals } from '@backend/domain/ota/SigningService';
import { StorageUnavailableError, StorageUploadMismatchError } from '@backend/domain/storage/errors';
import { EntityNotFoundError, UniqueConstraintError } from '@backend/infra/db/errors';

import type { ApiPrincipal } from '@backend/domain/apikey/ApiKeyService';
import type { AuditService } from '@backend/domain/audit/AuditService';
import type { JobQueue } from '@backend/domain/jobs/ports';
import type { OtaAppRepo, OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { OtaAssetRepo, OtaAssetWithObject } from '@backend/domain/ota/repos/ota-asset.repo';
import type {
  FinalizedContent,
  OtaReleaseRepo,
  OtaReleaseRow,
  OtaReleaseSummary,
} from '@backend/domain/ota/repos/ota-release.repo';
import type { UploadSessionRepo, UploadSessionRow } from '@backend/domain/ota/repos/upload-session.repo';
import type { SigningService } from '@backend/domain/ota/SigningService';
import type { StorageService } from '@backend/domain/storage/StorageService';
import type {
  BodySignature,
  ExpoManifest,
  ExpoManifestAsset,
  FinalizeRequest,
  OtaPlatform,
  OtaReleaseDto,
  OtaReleaseStatus,
  UploadRequest,
  UploadResponse,
} from '@mocco/common/ota-hosting';
import type { z } from 'zod';

/** Upload session tokens: `mk_ups_` and 43 base64url characters (32 random bytes). */
export const UPLOAD_SESSION_TOKEN_PREFIX = 'mk_ups_';

export interface UploadServiceDeps {
  apps: OtaAppRepo;
  sessions: UploadSessionRepo;
  releases: OtaReleaseRepo;
  assets: OtaAssetRepo;
  signing: SigningService;
  /** Undefined when this deployment has no object store: uploads are refused. */
  storage: StorageService | undefined;
  queue: JobQueue;
  audit: AuditService;
  now?: () => Date;
}

/** What a new session may do and who it speaks for. */
export interface SessionGrant {
  principal: string;
  apiKeyId?: string;
  trustPolicyId?: string;
  /** The person the session acts for, if any (a key's creator, a run's trigger). */
  actingUserId: string | null;
  /** Channels it may promote to; null for any unprotected one. */
  allowedChannels: string[] | null;
  /** Capped at 15 minutes. */
  ttlSeconds?: number;
}

export interface MintedSession {
  sessionToken: string;
  expiresAt: Date;
  allowedChannels: string[] | null;
}

/** One signed body of a finalize request, with what it was parsed into. */
interface SignedBody {
  platform: OtaPlatform;
  body: string;
  signature: BodySignature | null;
}

/** An Expo asset's hash as expo-updates computes it: base64url SHA-256, no padding. */
export const assetHashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64url');

const labelOf = (kind: string, platform: OtaPlatform) => `The ${platform} ${kind}`;

/** The first item per hash, in order. */
const uniqueByHash = <T extends { hash: string }>(items: readonly T[]): T[] =>
  items.filter((item, index) => items.findIndex(other => other.hash === item.hash) === index);

/** Every asset a manifest references, launch asset first. */
const assetsOf = (manifest: ExpoManifest): ExpoManifestAsset[] => [manifest.launchAsset, ...manifest.assets];

/** Parse a signed body as JSON and then as `schema`, or reject with what is wrong. */
function parseBody<S extends z.ZodType>(schema: S, body: string, label: string): z.infer<S> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (error) {
    throw new OtaUploadRejectedError(`${label} is not valid JSON`, { cause: error });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const where = issue === undefined || issue.path.length === 0 ? '' : ` at ${issue.path.join('.')}`;
    throw new OtaUploadRejectedError(`${label} is invalid${where}: ${issue?.message ?? 'unknown error'}`);
  }
  return parsed.data;
}

/** Asset URLs must be exactly `${assetBaseUrl}/${hash}`, so devices fetch them from Mocco. */
function checkAssetUrls(app: OtaAppRow, manifest: ExpoManifest, label: string): void {
  const wrong = assetsOf(manifest).find(asset => asset.url !== `${app.assetBaseUrl}/${asset.hash}`);
  if (wrong !== undefined) {
    throw new OtaUploadRejectedError(
      `${label}'s asset "${wrong.key}" has URL ${wrong.url}, but asset URLs must be ${app.assetBaseUrl}/<hash>`,
    );
  }
}

function toReleaseDto(row: OtaReleaseSummary): OtaReleaseDto {
  return {
    id: row.id,
    appId: row.appId,
    runtimeVersion: row.runtimeVersion,
    status: row.status,
    message: row.message,
    gitSha: row.gitSha,
    isMandatory: row.isMandatory,
    uploadedByPrincipal: row.uploadedByPrincipal,
    platforms: row.platforms,
    downloadBytes: row.downloadBytes,
    createdAt: row.createdAt,
  };
}

/**
 * Uploads from CI (OTA design §6.2). A session from a secret key declares a release and
 * its assets; Mocco answers with presigned PUTs for only the hashes it lacks, so an
 * unchanged asset is never uploaded twice. Finalize checks every signed body before
 * storing it — the manifest shape, runtime, `createdAt` bounds, asset URLs under the
 * app's base, the bytes' presence and the signature — and the `ota.verifyAssets` job
 * re-hashes new bytes before the release becomes `ready` (invariant 2).
 */
export class UploadService {
  private readonly now: () => Date;

  constructor(private readonly deps: UploadServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private requireStorage(): StorageService {
    if (this.deps.storage === undefined) {
      throw new StorageUnavailableError();
    }
    return this.deps.storage;
  }

  private async requireSessionApp(session: UploadSessionRow): Promise<OtaAppRow> {
    const app = await this.deps.apps.findById(session.appId);
    if (app === undefined) {
      throw new OtaAppNotFoundError(session.appId);
    }
    return app;
  }

  /** Check a body's signature: required on a `signing_required` app, and verified whenever given. */
  /** Check a body's signature; returns the certificate it verified against (null when unsigned). */
  private async checkSignature(app: OtaAppRow, signed: SignedBody, label: string): Promise<string | null> {
    if (signed.signature === null) {
      if (app.signingRequired) {
        throw new OtaUploadRejectedError(`${label} is unsigned, and this app requires signed updates`);
      }
      return null;
    }
    const { keyid } = signed.signature;
    const check = await this.deps.signing.verify(app.id, signed.body, serializeSignatureHeader(signed.signature));
    if (check.ok) {
      return check.certificateId;
    }
    if (check.refusal === SignatureRefusals.unknownKey) {
      throw new OtaUploadRejectedError(
        `${label} is signed with keyid "${keyid}", but the app has no active certificate with that keyid`,
      );
    }
    throw new OtaUploadRejectedError(
      `${label}'s signature doesn't verify against the app's certificate for keyid "${keyid}" — is the signing key the one that certificate was made from?`,
    );
  }

  /** A manifest's `createdAt` must be near the server clock: devices order updates by it. */
  private checkCommitTime(createdAt: Date, label: string): void {
    const now = this.now();
    if (createdAt.getTime() > now.getTime() + COMMIT_TIME_MAX_FUTURE_MS) {
      throw new OtaUploadRejectedError(
        `${label}'s createdAt ${createdAt.toISOString()} is more than 10 minutes ahead of the server clock (${now.toISOString()}); check the CI machine's clock`,
      );
    }
    if (createdAt.getTime() < now.getTime() - COMMIT_TIME_MAX_PAST_MS) {
      throw new OtaUploadRejectedError(
        `${label}'s createdAt ${createdAt.toISOString()} is more than 24 hours old; sign the manifest again`,
      );
    }
  }

  /** Every referenced hash must have bytes in storage: ready, or uploaded and not yet checked. */
  private async requireAssets(app: OtaAppRow, hashes: readonly string[]): Promise<OtaAssetWithObject[]> {
    const entries = await this.deps.assets.listWithObjects(app.id, hashes);
    const found = new Map(entries.map(entry => [entry.asset.hash, entry]));
    const missing = hashes.find(hash => {
      const status = found.get(hash)?.object?.status;
      return status !== ObjectStatuses.ready && status !== ObjectStatuses.pending;
    });
    if (missing !== undefined) {
      throw new OtaUploadRejectedError(
        `Asset ${missing} isn't stored: declare it in the upload and PUT its bytes before finalizing`,
      );
    }
    return entries;
  }

  /** Mark uploaded-but-unchecked objects ready (their size and type must match the declaration). */
  private async completePending(app: OtaAppRow, entries: readonly OtaAssetWithObject[]): Promise<void> {
    const storage = this.requireStorage();
    const pending = entries.filter(entry => entry.object?.status === ObjectStatuses.pending);
    await Promise.all(
      pending.map(async ({ asset, object }) => {
        try {
          await storage.completeUpload(app.workspaceId, object?.id ?? '');
        } catch (error) {
          if (error instanceof StorageUploadMismatchError) {
            throw new OtaUploadRejectedError(`Asset ${asset.hash} wasn't uploaded correctly: ${error.message}`, {
              cause: error,
            });
          }
          throw error;
        }
      }),
    );
  }

  /** Validate every body of a finalize request and build the rows to store. */
  private async checkFinalize(
    app: OtaAppRow,
    release: OtaReleaseRow,
    input: FinalizeRequest,
  ): Promise<FinalizedContent> {
    const platforms = input.updates.map(update => update.platform);
    if (new Set(platforms).size !== platforms.length) {
      throw new OtaUploadRejectedError('Each platform can have one update per release');
    }
    const content: FinalizedContent = { updates: [], updateAssets: [], directives: [] };
    const originals = new Map<OtaPlatform, { id: string; createdAt: Date }>();
    // Checked one at a time, so the first problem is the one reported.
    await input.updates.reduce(async (previous, update) => {
      await previous;
      const { manifest, certificateId } = await this.checkManifest(
        app,
        release,
        update,
        labelOf('manifest', update.platform),
      );
      originals.set(update.platform, { id: manifest.id, createdAt: new Date(manifest.createdAt) });
      this.addUpdate(content, app, release, update, manifest, {
        contentOf: manifest.id,
        supersedes: null,
        certificateId,
      });
    }, Promise.resolve());
    const targets = input.republishes.map(republish => `${republish.platform}:${republish.targetUpdateId}`);
    if (new Set(targets).size !== targets.length) {
      throw new OtaUploadRejectedError('Each rollback target needs one republish per platform');
    }
    await input.republishes.reduce(async (previous, republish) => {
      await previous;
      await this.addRepublish(content, app, release, republish, originals);
    }, Promise.resolve());
    await input.directives.reduce(async (previous, directive) => {
      await previous;
      await this.addDirective(content, app, release, directive, originals);
    }, Promise.resolve());
    return content;
  }

  /** Parse a manifest and check everything but asset presence. */
  private async checkManifest(
    app: OtaAppRow,
    release: OtaReleaseRow,
    signed: SignedBody,
    label: string,
  ): Promise<{ manifest: ExpoManifest; certificateId: string | null }> {
    const manifest = parseBody(expoManifestSchema, signed.body, label);
    if (manifest.runtimeVersion !== release.runtimeVersion) {
      throw new OtaUploadRejectedError(
        `${label}'s runtimeVersion "${manifest.runtimeVersion}" doesn't match the release's "${release.runtimeVersion}"`,
      );
    }
    this.checkCommitTime(new Date(manifest.createdAt), label);
    checkAssetUrls(app, manifest, label);
    const certificateId = await this.checkSignature(app, signed, label);
    return { manifest, certificateId };
  }

  private addUpdate(
    content: FinalizedContent,
    app: OtaAppRow,
    release: OtaReleaseRow,
    signed: SignedBody,
    manifest: ExpoManifest,
    links: { contentOf: string; supersedes: string | null; certificateId: string | null },
  ): void {
    content.updates.push({
      id: manifest.id,
      workspaceId: app.workspaceId,
      appId: app.id,
      releaseId: release.id,
      platform: signed.platform,
      runtimeVersion: manifest.runtimeVersion,
      kind: links.supersedes === null ? OtaUpdateKinds.original : OtaUpdateKinds.republish,
      contentOfUpdateId: links.contentOf,
      supersedesUpdateId: links.supersedes,
      commitTime: new Date(manifest.createdAt),
      manifestBody: signed.body,
      signature: signed.signature?.sig ?? null,
      keyid: signed.signature?.keyid ?? null,
      certificateId: links.certificateId,
      launchAssetHash: manifest.launchAsset.hash,
      // Summed from the stored asset sizes in finalize.
      totalBytes: 0,
      createdAt: this.now(),
    });
    content.updateAssets.push(
      ...uniqueByHash(assetsOf(manifest)).map(asset => ({
        updateId: manifest.id,
        appId: app.id,
        assetHash: asset.hash,
        key: asset.key,
        isLaunch: asset.hash === manifest.launchAsset.hash,
      })),
    );
  }

  /** A republish of a channel head's update, valid for devices on this release's update. */
  private async addRepublish(
    content: FinalizedContent,
    app: OtaAppRow,
    release: OtaReleaseRow,
    republish: FinalizeRequest['republishes'][number],
    originals: ReadonlyMap<OtaPlatform, { id: string; createdAt: Date }>,
  ): Promise<void> {
    const label = labelOf(`republish of ${republish.targetUpdateId}`, republish.platform);
    const target = await this.deps.releases.findUpdate(republish.targetUpdateId);
    if (target?.appId !== app.id || target.platform !== republish.platform) {
      throw new OtaUploadRejectedError(`${label} targets an update this app doesn't have on ${republish.platform}`);
    }
    const original = originals.get(republish.platform);
    if (original === undefined) {
      throw new OtaUploadRejectedError(`${label} needs this release's ${republish.platform} update`);
    }
    const { manifest, certificateId } = await this.checkManifest(app, release, republish, label);
    const targetHashes = new Set(await this.deps.releases.assetHashesOf(target.id));
    const hashes = assetsOf(manifest).map(asset => asset.hash);
    const isSameContent =
      manifest.launchAsset.hash === target.launchAssetHash &&
      hashes.length === targetHashes.size &&
      hashes.every(hash => targetHashes.has(hash));
    if (!isSameContent) {
      throw new OtaUploadRejectedError(`${label} must reference exactly the assets of the update it republishes`);
    }
    if (new Date(manifest.createdAt) <= original.createdAt) {
      throw new OtaUploadRejectedError(
        `${label}'s createdAt must be later than the release's update (${original.createdAt.toISOString()}), or devices on it won't load the rollback`,
      );
    }
    this.addUpdate(content, app, release, republish, manifest, {
      contentOf: target.contentOfUpdateId,
      supersedes: original.id,
      certificateId,
    });
  }

  /** A `rollBackToEmbedded` directive, valid for devices on this release's update. */
  private async addDirective(
    content: FinalizedContent,
    app: OtaAppRow,
    release: OtaReleaseRow,
    directive: SignedBody,
    originals: ReadonlyMap<OtaPlatform, { id: string; createdAt: Date }>,
  ): Promise<void> {
    const label = labelOf('rollBackToEmbedded directive', directive.platform);
    const parsed = parseBody(rollBackToEmbeddedDirectiveSchema, directive.body, label);
    const original = originals.get(directive.platform);
    if (original === undefined) {
      throw new OtaUploadRejectedError(`${label} needs this release's ${directive.platform} update`);
    }
    const commitTime = new Date(parsed.parameters.commitTime);
    if (commitTime <= original.createdAt) {
      throw new OtaUploadRejectedError(
        `${label}'s commitTime must be later than the release's update (${original.createdAt.toISOString()})`,
      );
    }
    this.checkCommitTime(commitTime, label);
    await this.checkSignature(app, directive, label);
    content.directives.push({
      workspaceId: app.workspaceId,
      appId: app.id,
      releaseId: release.id,
      platform: directive.platform,
      runtimeVersion: release.runtimeVersion,
      type: OtaDirectiveTypes.rollBackToEmbedded,
      commitTime,
      supersedesUpdateId: original.id,
      body: directive.body,
      signature: directive.signature?.sig ?? null,
      keyid: directive.signature?.keyid ?? null,
    });
  }

  /**
   * Mint an upload session for `app` (at most 15 minutes) and audit it. Every way in — a
   * secret key, a GitHub OIDC token, a broker-approved run step — ends here. The token is
   * returned once; only its hash is stored.
   */
  async mintSession(app: OtaAppRow, grant: SessionGrant): Promise<MintedSession> {
    // eslint-disable-next-line unicorn/prefer-uint8array-base64 -- Uint8Array#toBase64 isn't in Node 22
    const sessionToken = `${UPLOAD_SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const ttlSeconds = Math.min(grant.ttlSeconds ?? UPLOAD_SESSION_TTL_SECONDS, UPLOAD_SESSION_TTL_SECONDS);
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1000);
    const session = await this.deps.sessions.insert({
      workspaceId: app.workspaceId,
      appId: app.id,
      tokenHash: hashToken(sessionToken),
      principal: grant.principal,
      apiKeyId: grant.apiKeyId ?? null,
      trustPolicyId: grant.trustPolicyId ?? null,
      allowedChannels: grant.allowedChannels,
      actingUserId: grant.actingUserId,
      expiresAt,
      createdAt: this.now(),
    });
    await this.deps.audit.record(app.workspaceId, {
      actorUserId: null,
      action: AuditActions.otaUploadAuthorized,
      subjectType: 'ota_app',
      subjectId: app.id,
      payload: {
        sessionId: session.id,
        principal: grant.principal,
        trustPolicyId: grant.trustPolicyId ?? null,
        allowedChannels: grant.allowedChannels,
        expiresAt,
      },
    });
    return { sessionToken, expiresAt, allowedChannels: grant.allowedChannels };
  }

  /** Mint a session for a secret key whose project owns the app. */
  async createSession(principal: ApiPrincipal, appId: string): Promise<MintedSession> {
    const app = await this.deps.apps.findById(appId);
    if (app?.workspaceId !== principal.workspaceId || app.projectId !== principal.projectId) {
      throw new OtaAppNotFoundError(appId);
    }
    return await this.mintSession(app, {
      principal: `apikey:${principal.keyId}`,
      apiKeyId: principal.keyId,
      actingUserId: principal.createdByUserId,
      allowedChannels: null,
    });
  }

  /** The live session a token belongs to, or undefined (unknown, malformed or expired). */
  async authenticate(token: string): Promise<UploadSessionRow | undefined> {
    // eslint-disable-next-line sonarjs/null-dereference -- token is a string, never null
    if (!token.startsWith(UPLOAD_SESSION_TOKEN_PREFIX)) {
      return undefined;
    }
    const session = await this.deps.sessions.findByTokenHash(hashToken(token));
    return session !== undefined && session.expiresAt > this.now() ? session : undefined;
  }

  /** Declare a release: create it `uploading` and return PUTs for the assets Mocco lacks. */
  async beginRelease(session: UploadSessionRow, input: UploadRequest): Promise<UploadResponse> {
    if (session.releaseId !== null) {
      throw new OtaUploadConflictError(
        `This upload session already uploaded release ${session.releaseId}; start a new session`,
      );
    }
    const storage = this.requireStorage();
    const declared = uniqueByHash(input.assets);
    const app = await this.requireSessionApp(session);
    const release = await this.deps.releases.insert({
      workspaceId: app.workspaceId,
      appId: app.id,
      runtimeVersion: input.runtimeVersion,
      message: input.message,
      gitSha: input.gitSha,
      uploadedByPrincipal: session.principal,
      isMandatory: input.mandatory,
      createdAt: this.now(),
    });
    if (!(await this.deps.sessions.attachRelease(session.id, release.id))) {
      await this.deps.releases.setStatus(release.id, [OtaReleaseStatuses.uploading], OtaReleaseStatuses.failed);
      throw new OtaUploadConflictError('This upload session already uploaded a release; start a new session');
    }
    const stored = await this.deps.assets.listWithObjects(
      app.id,
      declared.map(asset => asset.hash),
    );
    const present = new Set(
      stored.filter(entry => entry.object?.status === ObjectStatuses.ready).map(entry => entry.asset.hash),
    );
    const toUpload = declared.filter(asset => !present.has(asset.hash));
    const missing = await Promise.all(
      toUpload.map(async asset => {
        const { object, upload } = await storage.beginUpload({
          workspaceId: app.workspaceId,
          projectId: app.projectId,
          product: Products.ota,
          filename: asset.ext === null ? asset.hash : `${asset.hash}.${asset.ext}`,
          contentType: asset.contentType,
          sizeBytes: asset.size,
          visibility: Visibilities.public,
        });
        await this.deps.assets.upsertPending({
          workspaceId: app.workspaceId,
          appId: app.id,
          hash: asset.hash,
          contentType: asset.contentType,
          fileExtension: asset.ext,
          sizeBytes: asset.size,
          objectId: object.id,
        });
        return { hash: asset.hash, putUrl: upload.url, headers: upload.headers };
      }),
    );
    const heads = await this.deps.releases.listActiveHeads(app.id, input.runtimeVersion, input.platforms);
    // One target per (platform, update): channels serving the same update share its republish.
    const rollbackTargets = heads
      .filter(
        (head, index) =>
          heads.findIndex(other => other.platform === head.platform && other.updateId === head.updateId) === index,
      )
      .map(head => ({
        ...head,
        channel: heads
          .filter(other => other.platform === head.platform && other.updateId === head.updateId)
          .map(other => other.channel)
          .join(', '),
      }));
    return { releaseId: release.id, assetBaseUrl: app.assetBaseUrl, missing, rollbackTargets };
  }

  /**
   * Check and store a release's signed bodies, then queue the re-hash that makes it
   * `ready`. Any problem rejects the whole finalize with a message saying what to fix;
   * nothing is stored until every body passes.
   */
  async finalize(
    session: UploadSessionRow,
    releaseId: string,
    input: FinalizeRequest,
  ): Promise<{ releaseId: string; status: string; updates: Partial<Record<OtaPlatform, string>> }> {
    if (session.releaseId !== releaseId) {
      throw new OtaReleaseNotFoundError(releaseId);
    }
    const app = await this.requireSessionApp(session);
    let release: OtaReleaseRow;
    try {
      release = await this.deps.releases.getInApp(app.id, releaseId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new OtaReleaseNotFoundError(releaseId, { cause: error });
      }
      throw error;
    }
    if (release.status !== OtaReleaseStatuses.uploading) {
      throw new OtaUploadConflictError(`Release ${releaseId} was already finalized (it is ${release.status})`);
    }
    const checked = await this.checkFinalize(app, release, input);
    const hashes = checked.updateAssets
      .map(link => link.assetHash)
      .filter((hash, index, all) => all.indexOf(hash) === index);
    const found = await this.requireAssets(app, hashes);
    await this.completePending(app, found);
    const sizeOf = (hash: string) => found.find(entry => entry.asset.hash === hash)?.asset.sizeBytes ?? 0;
    const content: FinalizedContent = {
      ...checked,
      updates: checked.updates.map(update => ({
        ...update,
        totalBytes: checked.updateAssets
          .filter(link => link.updateId === update.id)
          .reduce((sum, link) => sum + sizeOf(link.assetHash), 0),
      })),
    };
    let isStored: boolean;
    try {
      isStored = await this.deps.releases.storeFinalized(release.id, content);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new OtaUploadRejectedError(
          error.constraint === 'mocco_ota_updates_pkey'
            ? 'An update id in this release was used before; sign manifests with new ids'
            : `The release's updates conflict (${error.constraint})`,
          { cause: error },
        );
      }
      throw error;
    }
    if (!isStored) {
      throw new OtaUploadConflictError(`Release ${releaseId} was already finalized`);
    }
    await this.deps.queue.enqueue(
      verifyOtaAssets,
      { releaseId: release.id },
      { dedupeKey: release.id, workspaceId: app.workspaceId, kick: true },
    );
    const originals = content.updates.filter(update => update.kind === OtaUpdateKinds.original);
    const updates = Object.fromEntries(originals.map(update => [update.platform, update.id]));
    await this.deps.audit.record(app.workspaceId, {
      actorUserId: null,
      action: AuditActions.otaReleaseUploaded,
      subjectType: 'ota_release',
      subjectId: release.id,
      payload: {
        appId: app.id,
        runtimeVersion: release.runtimeVersion,
        gitSha: release.gitSha,
        principal: session.principal,
        updates,
        republishes: content.updates.length - originals.length,
        directives: content.directives.length,
      },
    });
    return { releaseId: release.id, status: OtaReleaseStatuses.verifying, updates };
  }

  /**
   * The `ota.verifyAssets` job: re-hash every not-yet-verified asset of a `verifying`
   * release from storage. All match → `ready`. A mismatch or lost bytes → `failed`; the
   * bad bytes are deleted so the next upload of that hash replaces them.
   */
  async verifyAssets(releaseId: string): Promise<OtaReleaseStatus> {
    const release = await this.deps.releases.findById(releaseId);
    if (release?.status !== OtaReleaseStatuses.verifying) {
      return release?.status ?? OtaReleaseStatuses.failed;
    }
    const storage = this.requireStorage();
    const unverified = await this.deps.assets.listUnverifiedForRelease(releaseId);
    // One at a time: each asset is read into memory (bounded by the 50 MiB product cap).
    const failure = await unverified.reduce<Promise<string | null>>(async (previous, { asset, object }) => {
      const earlier = await previous;
      if (earlier !== null) {
        return earlier;
      }
      const bytes = object?.status === ObjectStatuses.ready ? await storage.read(release.workspaceId, object.id) : null;
      if (bytes !== null && assetHashOf(bytes) === asset.hash) {
        await this.deps.assets.markVerified(asset.appId, asset.hash, this.now());
        return null;
      }
      if (object !== null) {
        await storage.delete(release.workspaceId, object.id);
      }
      await this.deps.assets.clearObject(asset.appId, asset.hash);
      return bytes === null
        ? `asset ${asset.hash} has no stored bytes`
        : `asset ${asset.hash}'s stored bytes hash to ${assetHashOf(bytes)}`;
    }, Promise.resolve(null));
    if (failure === null) {
      await this.deps.releases.setStatus(releaseId, [OtaReleaseStatuses.verifying], OtaReleaseStatuses.ready);
      return OtaReleaseStatuses.ready;
    }
    if (await this.deps.releases.setStatus(releaseId, [OtaReleaseStatuses.verifying], OtaReleaseStatuses.failed)) {
      await this.deps.audit.record(release.workspaceId, {
        actorUserId: null,
        action: AuditActions.otaReleaseFailed,
        subjectType: 'ota_release',
        subjectId: releaseId,
        payload: { reason: failure },
      });
    }
    return OtaReleaseStatuses.failed;
  }

  /** One release of the app, or OtaReleaseNotFoundError. */
  async getRelease(app: OtaAppRow, releaseId: string): Promise<OtaReleaseDto> {
    const [row] = await this.deps.releases.listByApp(app.workspaceId, app.id, { releaseId, limit: 1 });
    if (row === undefined) {
      throw new OtaReleaseNotFoundError(releaseId);
    }
    return toReleaseDto(row);
  }

  async listReleases(app: OtaAppRow): Promise<OtaReleaseDto[]> {
    const rows = await this.deps.releases.listByApp(app.workspaceId, app.id);
    return rows.map(row => toReleaseDto(row));
  }

  /** The daily `ota.uploadSessions.prune` job: drop expired sessions, and fail releases
   * whose session expired before they were finalized (abandoned uploads). */
  async pruneSessions(): Promise<{ sessions: number; abandoned: number }> {
    const now = this.now();
    const abandoned = await this.deps.releases.failStaleUploading(
      new Date(now.getTime() - UPLOAD_SESSION_TTL_SECONDS * 1000),
    );
    return { sessions: await this.deps.sessions.deleteExpired(now), abandoned };
  }
}
