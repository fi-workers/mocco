// What went wrong in a check, as the probe protocol's `errorKind`. Node and undici report
// failures by `code` (sometimes on a wrapped `cause`); this is the one place that reads them.
import { CheckErrorKinds, ProbeProtocol, type CheckErrorKind } from '@mocco/common/status';

/** A hosted probe refused a target that resolves to an address it may not reach. */
export class BlockedAddressError extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
  ) {
    super(
      host === address
        ? `${address} is an address this probe may not reach`
        : `${host} resolves to ${address}, an address this probe may not reach`,
    );
    this.name = 'BlockedAddressError';
  }
}

/** Mocco refused the location token. Retrying won't help. */
export class ProbeAuthError extends Error {
  constructor() {
    super('Mocco refused the location token (401): check MOCCO_PROBE_TOKEN, or whether the location was disabled');
    this.name = 'ProbeAuthError';
  }
}

/** Mocco answered with an unexpected status, or not at all. Worth retrying later. */
export class ProbeRequestError extends Error {
  constructor(
    readonly path: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ProbeRequestError';
  }
}

/** The name resolved, but to no address. */
export class NoAddressError extends Error {
  readonly code = 'ENOTFOUND';

  constructor(readonly host: string) {
    super(`${host} has no addresses`);
    this.name = 'NoAddressError';
  }
}

/** The check's own deadline passed. */
export class CheckTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`No answer within ${timeoutMs} ms`);
    this.name = 'CheckTimeoutError';
  }
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'ENODATA', 'ESERVFAIL']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'HOSTNAME_MISMATCH',
]);

/** The error and its causes, outermost first (bounded, in case a cause chain loops). */
const chainOf = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  let current = error;
  while (current !== undefined && current !== null && chain.length < 5) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
};

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  return typeof error.code === 'string' ? error.code : undefined;
};

const kindOfOne = (error: unknown): CheckErrorKind | undefined => {
  if (error instanceof CheckTimeoutError) {
    return CheckErrorKinds.timeout;
  }
  if (error instanceof BlockedAddressError) {
    return CheckErrorKinds.connect;
  }
  const code = codeOf(error);
  if (code === undefined) {
    return undefined;
  }
  if (DNS_CODES.has(code)) {
    return CheckErrorKinds.dns;
  }
  if (TIMEOUT_CODES.has(code)) {
    return CheckErrorKinds.timeout;
  }
  // eslint-disable-next-line sonarjs/null-dereference -- code is a string, narrowed above
  if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) {
    return CheckErrorKinds.tls;
  }
  return undefined;
};

/** The protocol's error kind for a failed check: the first cause that says, else `connect`. */
export const errorKindOf = (error: unknown): CheckErrorKind =>
  chainOf(error)
    .map(link => kindOfOne(link))
    .find(kind => kind !== undefined) ?? CheckErrorKinds.connect;

/** A one-line description for the result's `detail`, within the protocol's limit. */
export const truncateDetail = (text: string): string =>
  // eslint-disable-next-line sonarjs/null-dereference -- text is a string, never null
  text.length > ProbeProtocol.detailMax ? `${text.slice(0, ProbeProtocol.detailMax - 1)}…` : text;

export const describeError = (error: unknown): string => {
  const innermost = chainOf(error).findLast(link => link instanceof Error);
  const outer = error instanceof Error ? error.message : String(error);
  const message = innermost instanceof Error && innermost !== error ? `${outer}: ${innermost.message}` : outer;
  const code = codeOf(innermost) ?? codeOf(error);
  // eslint-disable-next-line sonarjs/null-dereference -- message is a string, never null
  return truncateDetail(code === undefined || message.includes(code) ? message : `${code} ${message}`);
};
