// The browser bundles' size budgets (platform foundations §11; #177 for the widgets): the gzipped
// sum of every built file an entry loads, sdk-core included. A conservative measure: a
// customer's bundler tree-shakes and minifies below it.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const sdkCoreChunks = readdirSync(new URL('../packages/sdk-core/dist/', import.meta.url))
  .filter(name => name.startsWith('chunk-') && name.endsWith('.js'))
  .map(name => `packages/sdk-core/dist/${name}`);

const budgets = [
  {
    name: '@mocco/js core',
    bytes: 10 * KB,
    files: ['packages/sdk-js/dist/mocco-js.js', 'packages/sdk-core/dist/sdk-core.js'],
  },
  {
    name: '@mocco/js/whats-new widget',
    bytes: 25 * KB,
    files: [
      'packages/sdk-js/dist/whats-new.js',
      'packages/sdk-core/dist/whats-new.js',
      'packages/sdk-core/dist/feedback.js',
      'packages/sdk-core/dist/sdk-core.js',
      ...sdkCoreChunks,
    ],
  },
  {
    name: '@mocco/js/feedback-sheet widget',
    bytes: 25 * KB,
    files: [
      'packages/sdk-js/dist/feedback-sheet.js',
      'packages/sdk-core/dist/feedback-sheet.js',
      'packages/sdk-core/dist/feedback.js',
      'packages/sdk-core/dist/sdk-core.js',
      ...sdkCoreChunks,
    ],
  },
];

const over = budgets.filter(({ name, bytes, files }) => {
  const gzipped = files.reduce(
    (sum, file) => sum + gzipSync(readFileSync(new URL(`../${file}`, import.meta.url))).length,
    0,
  );
  console.log(`${name}: ${gzipped} bytes gzipped (budget ${bytes})`);
  return gzipped > bytes;
});
if (over.length > 0) {
  console.error(`Over the size budget: ${over.map(({ name }) => name).join(', ')}`);
  process.exit(1);
}
