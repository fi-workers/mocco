// Copies the customer guides' screenshots (docs/customer/notifications/images/) to where
// the app serves them (packages/frontend/public/docs/notifications/images/). The guides
// keep the images next to the Markdown, so GitHub renders them too; the frontend's `dev`
// and `build` scripts run this first. The copy is gitignored.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const from = path.join(root, 'docs', 'customer', 'notifications', 'images');
const to = path.join(root, 'packages', 'frontend', 'public', 'docs', 'notifications', 'images');

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
if (existsSync(from)) {
  cpSync(from, to, { recursive: true });
}
