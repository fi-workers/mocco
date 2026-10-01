import { AuditActions } from '@mocco/common/audit';
import { CertificateStatuses } from '@mocco/common/ota-hosting';

import {
  InvalidSigningCertificateError,
  SigningCertificateExistsError,
  SigningCertificateNotFoundError,
} from '@backend/domain/ota/errors';
import { isSignatureValid, parseSignatureHeader, readCertificate } from '@backend/domain/ota/manifest/signature';
import { EntityNotFoundError, UniqueConstraintError } from '@backend/infra/db/errors';

import type { AuditService } from '@backend/domain/audit/AuditService';
import type { OtaAppRow } from '@backend/domain/ota/repos/ota-app.repo';
import type { SigningCertificateRepo, SigningCertificateRow } from '@backend/domain/ota/repos/signing-certificate.repo';
import type { SigningCertificateDto, SigningCertificateInput } from '@mocco/common/ota-hosting';

export interface SigningServiceDeps {
  certificates: SigningCertificateRepo;
  audit: AuditService;
  now?: () => Date;
}

/** Why a signature was refused. */
export const SignatureRefusals = {
  missing: 'missing',
  malformed: 'malformed',
  unknownKey: 'unknown_key',
  invalid: 'invalid',
} as const;
export type SignatureRefusal = (typeof SignatureRefusals)[keyof typeof SignatureRefusals];

export type SignatureCheck = { ok: true; keyid: string; sig: string } | { ok: false; refusal: SignatureRefusal };

export function toCertificateDto(row: SigningCertificateRow): SigningCertificateDto {
  return {
    id: row.id,
    appId: row.appId,
    keyid: row.keyid,
    spkiSha256: row.spkiSha256,
    subject: row.subject,
    notAfter: row.notAfter,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/**
 * Code-signing certificates of hosted OTA apps (ADR 0022): Mocco stores certificates,
 * never keys, and verifies every signed body before storing it. Several certificates can
 * be active at once, because rotating needs a new binary and old ones still verify
 * against the old certificate.
 */
export class SigningService {
  private readonly now: () => Date;

  constructor(private readonly deps: SigningServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(app: OtaAppRow): Promise<SigningCertificateDto[]> {
    const rows = await this.deps.certificates.listByApp(app.workspaceId, app.id);
    return rows.map(row => toCertificateDto(row));
  }

  /** Register the certificate an app embeds. It must be an unexpired RSA X.509 certificate. */
  async add(app: OtaAppRow, actorUserId: string, input: SigningCertificateInput): Promise<SigningCertificateDto> {
    let info: ReturnType<typeof readCertificate>;
    try {
      info = readCertificate(input.certificatePem);
    } catch (error) {
      throw new InvalidSigningCertificateError('it is not a PEM X.509 certificate', { cause: error });
    }
    if (!info.isRsa) {
      throw new InvalidSigningCertificateError('expo-updates verifies RSA signatures only (rsa-v1_5-sha256)');
    }
    if (info.notAfter <= this.now()) {
      throw new InvalidSigningCertificateError(`it expired on ${info.notAfter.toISOString()}`);
    }
    let row: SigningCertificateRow;
    try {
      row = await this.deps.certificates.insert({
        workspaceId: app.workspaceId,
        appId: app.id,
        keyid: input.keyid,
        certificatePem: input.certificatePem.trim(),
        spkiSha256: info.spkiSha256,
        subject: info.subject,
        notAfter: info.notAfter,
        createdByUserId: actorUserId,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new SigningCertificateExistsError({ cause: error });
      }
      throw error;
    }
    await this.deps.audit.record(app.workspaceId, {
      actorUserId,
      action: AuditActions.otaCertAdded,
      subjectType: 'ota_app',
      subjectId: app.id,
      payload: { certificateId: row.id, keyid: row.keyid, spkiSha256: row.spkiSha256, notAfter: row.notAfter },
    });
    return toCertificateDto(row);
  }

  /** Stop accepting signatures from a certificate (devices that embed it get nothing new). */
  async retire(app: OtaAppRow, actorUserId: string, certificateId: string): Promise<void> {
    let row: SigningCertificateRow;
    try {
      row = await this.deps.certificates.getInApp(app.workspaceId, app.id, certificateId);
    } catch (error) {
      if (error instanceof EntityNotFoundError) {
        throw new SigningCertificateNotFoundError(certificateId, { cause: error });
      }
      throw error;
    }
    if (row.status === CertificateStatuses.retired) {
      return;
    }
    await this.deps.certificates.retire(row.id);
    await this.deps.audit.record(app.workspaceId, {
      actorUserId,
      action: AuditActions.otaCertRetired,
      subjectType: 'ota_app',
      subjectId: app.id,
      payload: { certificateId: row.id, keyid: row.keyid },
    });
  }

  /** Verify an `expo-signature` header over `body` against the app's active certificates
   * for its keyid. */
  async verify(appId: string, body: string, header: string | undefined): Promise<SignatureCheck> {
    if (header === undefined || header === '') {
      return { ok: false, refusal: SignatureRefusals.missing };
    }
    const parsed = parseSignatureHeader(header);
    if (parsed === null) {
      return { ok: false, refusal: SignatureRefusals.malformed };
    }
    const certificates = await this.deps.certificates.listActive(appId, parsed.keyid);
    if (certificates.length === 0) {
      return { ok: false, refusal: SignatureRefusals.unknownKey };
    }
    const isValid = certificates.some(certificate => isSignatureValid(body, parsed.sig, certificate.certificatePem));
    return isValid
      ? { ok: true, keyid: parsed.keyid, sig: parsed.sig }
      : { ok: false, refusal: SignatureRefusals.invalid };
  }
}
