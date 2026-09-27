// Copies each customer guide set's screenshots (docs/customer/<set>/images/) to where the
// app serves them (packages/frontend/public/docs/<set>/images/). The guides keep the
// images next to the Markdown, so GitHub renders them too; the frontend's `dev` and
// `build` scripts run this first. The copy is gitignored.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guides = path.join(root, 'docs', 'customer');
const served = path.join(root, 'packages', 'frontend', 'public', 'docs');

rmSync(served, { recursive: true, force: true });
for (const entry of readdirSync(guides, { withFileTypes: true })) {
  const from = path.join(guides, entry.name, 'images');
  if (entry.isDirectory() && existsSync(from)) {
    const to = path.join(served, entry.name, 'images');
    mkdirSync(to, { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}
