// Packs Twemoji's SVGs into the one brotli file the OG renderer reads for emoji
// (docs/reference/og-images.md). Keys are Twemoji's file names: the code points in lowercase
// hex, joined by "-".
//
// Source: assets/svg from github.com/jdecked/twemoji at tag v17.0.3 (graphics CC-BY 4.0).
//
//   node scripts/og-assets/pack-twemoji.mjs twemoji-17.0.3/assets/svg packages/backend/src/domain/og/emoji/twemoji.json.br
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const [svgDir, out] = process.argv.slice(2);
if (svgDir === undefined || out === undefined) {
  console.error('usage: pack-twemoji.mjs <assets/svg dir> <out file>');
  process.exit(1);
}

const pack = Object.fromEntries(
  readdirSync(svgDir)
    .filter(file => file.endsWith('.svg'))
    .toSorted()
    .map(file => [file.slice(0, -'.svg'.length), readFileSync(path.join(svgDir, file), 'utf8').trim()]),
);
const packed = brotliCompressSync(JSON.stringify(pack), {
  params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
});
writeFileSync(out, packed);
console.log(`${Object.keys(pack).length} emoji, ${packed.length} bytes → ${out}`);
