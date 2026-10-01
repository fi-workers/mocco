// The browser bundle's size budget (platform foundations §11): the core stays small.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 10 * 1024;
const files = ['packages/sdk-js/dist/mocco-js.js', 'packages/sdk-core/dist/sdk-core.js'];
const gzipped = files.reduce(
  (sum, file) => sum + gzipSync(readFileSync(new URL(`../${file}`, import.meta.url))).length,
  0,
);
console.log(`@mocco/js core: ${gzipped} bytes gzipped (budget ${BUDGET_BYTES})`);
if (gzipped > BUDGET_BYTES) {
  console.error('@mocco/js is over its size budget');
  process.exit(1);
}
