// Publish the public workspaces to npm with the npm CLI, in dependency order.
//
// `changeset publish` can't do this here. Changesets publishes through the detected
// package manager, which is yarn, and yarn has no support for npm's trusted publishing:
// it looks for an `npmAuthToken` and fails with `YN0033: No authentication configured`
// no matter what OIDC the job was granted. npm's own CLI (>= 11.5.1) exchanges the
// Actions OIDC token for a short-lived registry credential, which is what lets this
// repository publish without storing a long-lived npm token at all (ADR: ci-conventions).
//
// Versions come from `changeset version` as before; this script only uploads what that
// produced, skips anything already on the registry (so a re-run is safe), and prints the
// `New tag:` lines `changesets/action` reads to create the git tags and GitHub releases.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every workspace, as yarn reports them. */
function workspaces() {
  const output = execFileSync('yarn', ['workspaces', 'list', '--json'], { cwd: ROOT, encoding: 'utf8' });
  return output
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
    .filter(workspace => workspace.location !== '.')
    .map(workspace => {
      const manifest = JSON.parse(readFileSync(path.join(ROOT, workspace.location, 'package.json'), 'utf8'));
      return { location: workspace.location, manifest };
    })
    .filter(workspace => workspace.manifest.private !== true);
}

/**
 * Dependency order, so a package is on the registry before anything that depends on it.
 * `changeset version` has already rewritten `workspace:*` to real ranges, so a consumer
 * installing between two uploads would otherwise hit a version that doesn't exist yet.
 */
function inDependencyOrder(packages) {
  const byName = new Map(packages.map(each => [each.manifest.name, each]));
  const ordered = [];
  const seen = new Set();
  const visit = each => {
    if (seen.has(each.manifest.name)) {
      return;
    }
    seen.add(each.manifest.name);
    const dependencies = Object.keys(each.manifest.dependencies ?? {});
    for (const name of dependencies) {
      const dependency = byName.get(name);
      if (dependency !== undefined) {
        visit(dependency);
      }
    }
    ordered.push(each);
  };
  for (const each of packages) {
    visit(each);
  }
  return ordered;
}

/** Whether this exact version is already on the registry (a re-run, or a partial failure). */
function isPublished(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const packages = inDependencyOrder(workspaces());
let published = 0;

for (const { location, manifest } of packages) {
  const { name, version } = manifest;
  if (isPublished(name, version)) {
    process.stdout.write(`Already on npm, skipping: ${name}@${version}\n`);
    continue;
  }
  process.stdout.write(`Publishing ${name}@${version}…\n`);
  execFileSync('npm', ['publish', '--provenance', '--access', 'public'], {
    cwd: path.join(ROOT, location),
    stdio: 'inherit',
  });
  // Read by changesets/action to tag the commit and open the GitHub release.
  process.stdout.write(`New tag: ${name}@${version}\n`);
  published += 1;
}

process.stdout.write(`Published ${published} of ${packages.length} package(s).\n`);
