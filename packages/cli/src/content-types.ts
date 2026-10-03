// The content type Mocco stores and serves an exported file with, by extension.
const byExtension: Record<string, string> = {
  bundle: 'application/javascript',
  hbc: 'application/javascript',
  js: 'application/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

const FALLBACK = 'application/octet-stream';

export function contentTypeOf(ext: string | null): string {
  if (ext === null) {
    return FALLBACK;
  }
  // eslint-disable-next-line sonarjs/null-dereference -- narrowed to a string above
  return byExtension[ext.toLowerCase()] ?? FALLBACK;
}
