// Which flag keys a commit's code mentions (#146, design open question 8): the warning
// when a flag is enabled before the code that reads it was deployed. Pure: it reads a
// repository archive (a gzipped tar, as GitHub serves it) and looks for each key as a
// quoted string ('key', "key" or `key`), the way SDK calls name a flag. Bounded: large,
// binary and vendored files are skipped, and the scan stops at a total size or once
// every key is found.
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const BLOCK = 512;
/** Files larger than this are skipped (bundles, lockfiles, data). */
const MAX_FILE_BYTES = 1024 * 1024;
/** Uncompressed bytes read before giving up on the rest of the archive. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const SKIPPED_DIRS = /(?:^|\/)(?:node_modules|vendor|dist|build|\.git|Pods|\.next)\//u;
const QUOTES = ["'", '"', '`'] as const;

export interface CodeRefScan {
  /** The keys some text file quotes. */
  found: Set<string>;
  /** Whether the whole archive was read (false: it hit the size limit first). */
  isComplete: boolean;
}

const gunzipAsync = promisify(gunzip);

const readString = (block: Uint8Array, start: number, length: number): string => {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
};

const isBinary = (data: Uint8Array): boolean => data.subarray(0, 8000).includes(0);

/** Every key that `text` quotes. */
function quotedKeys(text: string, keys: readonly string[]): string[] {
  // eslint-disable-next-line sonarjs/null-dereference -- a decoded file, never null
  return keys.filter(key => QUOTES.some(quote => text.includes(`${quote}${key}${quote}`)));
}

interface TarEntry {
  path: string;
  data: Uint8Array;
}

/** The regular files of a tar worth reading, up to the total size limit. */
function readEntries(tar: Uint8Array): { entries: TarEntry[]; isComplete: boolean } {
  const entries: TarEntry[] = [];
  let offset = 0;
  let total = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    const name = readString(header, 0, 100);
    if (name === '') {
      break;
    }
    const size = Number.parseInt(readString(header, 124, 12).trim() || '0', 8);
    const start = offset + BLOCK;
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    total += size;
    if (total > MAX_TOTAL_BYTES) {
      return { entries, isComplete: false };
    }
    const prefix = readString(header, 345, 155);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const isRegularFile = header[156] === 0x30 || header[156] === 0;
    if (isRegularFile && size > 0 && size <= MAX_FILE_BYTES && !SKIPPED_DIRS.test(path)) {
      entries.push({ path, data: tar.subarray(start, start + size) });
    }
  }
  return { entries, isComplete: true };
}

/**
 * Scan a gzipped tar for quoted mentions of `keys`. GitHub's archives put every path
 * under one top directory; non-file entries (directories, links, pax headers) are skipped.
 */
export async function scanArchive(gzipped: Uint8Array, keys: readonly string[]): Promise<CodeRefScan> {
  const { entries, isComplete } = readEntries(await gunzipAsync(gzipped));
  const decoder = new TextDecoder();
  const found = entries
    .filter(entry => !isBinary(entry.data))
    .reduce((acc, entry) => {
      const missing = keys.filter(key => !acc.has(key));
      return missing.length === 0 ? acc : new Set([...acc, ...quotedKeys(decoder.decode(entry.data), missing)]);
    }, new Set<string>());
  return { found, isComplete };
}
