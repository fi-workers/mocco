import { randomBytes, randomUUID } from 'node:crypto';

import { InboundKinds, InboundSourceStatuses } from '@mocco/common/inbound';

import { inboundSecretAad, INBOUND_INGEST_PATH } from '@backend/domain/inbound/constants';
import {
  InboundSecretNotAcceptedError,
  InboundSecretRequiredError,
  InboundSourceNotFoundError,
} from '@backend/domain/inbound/errors';
import { EntityNotFoundError } from '@backend/infra/db/errors';

import type { InboundSourceRepo, InboundSourceRow } from '@backend/domain/inbound/repos/inbound-source.repo';
import type { SecretBox } from '@backend/infra/crypto/secret-box';
import type {
  InboundKind,
  InboundSourceCreateInput,
  InboundSourceDto,
  InboundSourceStatus,
} from '@mocco/common/inbound';

export interface SourceServiceDeps {
  sources: InboundSourceRepo;
  box: Pick<SecretBox, 'seal'>;
  /** The app's own origin (`https://www.mocco.club`); ingest URLs are built on it. */
  baseOrigin: string;
}

/** A source write that may hand back a secret Mocco generated (GitHub only). */
export interface SourceWithSecret {
  source: InboundSourceDto;
  /** The generated secret, shown once; null when the customer pasted theirs. */
  generatedSecret: string | null;
}

/** 32 random bytes, base64url. */
function randomToken(): string {
  // Buffer is the available base64url codec (see infra/crypto/secret-box.ts).
  // eslint-disable-next-line unicorn/prefer-uint8array-base64
  return randomBytes(32).toString('base64url');
}

/** Kinds whose secret Mocco generates (the customer pastes it into the vendor). */
const GENERATED_SECRET_KINDS: ReadonlySet<InboundKind> = new Set([InboundKinds.github]);

/** The plaintext secret for a new or rotated source: generated for GitHub, the pasted
 * one (trimmed, non-empty) otherwise. */
function resolveSecret(kind: InboundKind, pasted: string | undefined): { secret: string; generated: boolean } {
  const trimmed = pasted?.trim();
  if (GENERATED_SECRET_KINDS.has(kind)) {
    if (trimmed !== undefined) {
      throw new InboundSecretNotAcceptedError(kind);
    }
    return { secret: randomBytes(32).toString('hex'), generated: true };
  }
  if (trimmed === undefined || trimmed === '') {
    throw new InboundSecretRequiredError(kind);
  }
  return { secret: trimmed, generated: false };
}

/** Run a repo call, turning its EntityNotFoundError into InboundSourceNotFoundError. */
async function mapNotFound<T>(sourceId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EntityNotFoundError) {
      throw new InboundSourceNotFoundError(sourceId, { cause: error });
    }
    throw error;
  }
}

/**
 * Owns a workspace's inbound sources (notification relay design §5): creating one
 * with its ingest key and sealed secret, renaming, pausing, rotating the secret, and
 * deleting. It never returns the secret or the sealed value, except a secret Mocco
 * generated, once, from `create` / `rotateSecret`. Every operation is workspace-scoped.
 */
export class SourceService {
  constructor(private readonly deps: SourceServiceDeps) {}

  /** The wire view: an explicit projection, so the sealed secret never leaves here. */
  private toDto(row: InboundSourceRow): InboundSourceDto {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      status: row.status,
      hasSecret: row.secretSealed !== '',
      ingestUrl: this.ingestUrl(row.ingestKey),
      lastReceivedAt: row.lastReceivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** The URL a vendor delivers to. */
  ingestUrl(ingestKey: string): string {
    return `${this.deps.baseOrigin}${INBOUND_INGEST_PATH}/${ingestKey}`;
  }

  async create(workspaceId: string, input: InboundSourceCreateInput): Promise<SourceWithSecret> {
    const { secret, generated } = resolveSecret(input.kind, input.secret);
    // The id is generated here so the AAD binding the sealed secret to its row is
    // known before the insert.
    const id = randomUUID();
    const row = await this.deps.sources.create({
      id,
      workspaceId,
      kind: input.kind,
      name: input.name.trim(),
      ingestKey: randomToken(),
      secretSealed: this.deps.box.seal(secret, inboundSecretAad(id)),
    });
    return { source: this.toDto(row), generatedSecret: generated ? secret : null };
  }

  /** The workspace's sources, oldest first. */
  async list(workspaceId: string): Promise<InboundSourceDto[]> {
    const rows = await this.deps.sources.listByWorkspace(workspaceId);
    return rows.map(row => this.toDto(row));
  }

  async get(workspaceId: string, sourceId: string): Promise<InboundSourceDto> {
    const row = await mapNotFound(
      sourceId,
      async () => await this.deps.sources.getByIdInWorkspace(workspaceId, sourceId),
    );
    return this.toDto(row);
  }

  async rename(workspaceId: string, sourceId: string, name: string): Promise<InboundSourceDto> {
    const row = await mapNotFound(
      sourceId,
      // sonarjs/null-dereference is a false positive: `name` is a required string.
      // eslint-disable-next-line sonarjs/null-dereference
      async () => await this.deps.sources.update(workspaceId, sourceId, { name: name.trim() }),
    );
    return this.toDto(row);
  }

  /** Pause (deliveries answer 404 and write nothing) or resume a source. */
  async setStatus(workspaceId: string, sourceId: string, status: InboundSourceStatus): Promise<InboundSourceDto> {
    const row = await mapNotFound(
      sourceId,
      async () => await this.deps.sources.update(workspaceId, sourceId, { status }),
    );
    return this.toDto(row);
  }

  async pause(workspaceId: string, sourceId: string): Promise<InboundSourceDto> {
    return await this.setStatus(workspaceId, sourceId, InboundSourceStatuses.paused);
  }

  async resume(workspaceId: string, sourceId: string): Promise<InboundSourceDto> {
    return await this.setStatus(workspaceId, sourceId, InboundSourceStatuses.active);
  }

  /** Replace the secret: a new generated one for GitHub (returned once), the newly
   * pasted one otherwise. The ingest key stays, so the vendor URL does not change. */
  async rotateSecret(workspaceId: string, sourceId: string, pasted: string | undefined): Promise<SourceWithSecret> {
    const current = await mapNotFound(
      sourceId,
      async () => await this.deps.sources.getByIdInWorkspace(workspaceId, sourceId),
    );
    const { secret, generated } = resolveSecret(current.kind, pasted);
    const row = await mapNotFound(
      sourceId,
      async () =>
        await this.deps.sources.update(workspaceId, sourceId, {
          secretSealed: this.deps.box.seal(secret, inboundSecretAad(sourceId)),
        }),
    );
    return { source: this.toDto(row), generatedSecret: generated ? secret : null };
  }

  /** Delete a source and its receipts. Its ingest URL answers 404 from then on. */
  async delete(workspaceId: string, sourceId: string): Promise<void> {
    if (!(await this.deps.sources.delete(workspaceId, sourceId))) {
      throw new InboundSourceNotFoundError(sourceId);
    }
  }
}
