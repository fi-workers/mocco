// Small pure helpers for help center text: the content hash and segment hashes revisions
// carry, and the short public ids of articles.
import { createHash, randomBytes } from 'node:crypto';

import { segmentRefsOf } from '@backend/domain/helpcenter/markdown/segment';

/** sha256 of the normalized title and body (line endings and trailing space don't count). */
export function contentHashOf(title: string, body: string): string {
  /* eslint-disable sonarjs/null-dereference -- title, body and each line are strings, never null */
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  const normalized = `${title.trim()}\n\n${lines
    .map(line => line.trimEnd())
    .join('\n')
    .trim()}`;
  /* eslint-enable sonarjs/null-dereference */
  return createHash('sha256').update(normalized).digest('hex');
}

/** The text columns of a revision: title, body, content hash and segment hashes. */
export function revisionText(title: string, body: string) {
  return { title, bodyMd: body, contentHash: contentHashOf(title, body), segments: segmentRefsOf(title, body) };
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A 6-character public id (lowercase, no look-alike characters). */
export function newShortId(): string {
  return [...randomBytes(6)].map(byte => ALPHABET[byte % ALPHABET.length]).join('');
}
