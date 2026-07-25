#!/usr/bin/env tsx
/**
 * Dependency-free two-layer env loader.
 *
 * Load order (later wins):
 *   1. packages/<app>/env/.env.<environment> — committed defaults
 *   2. packages/<app>/env/.env               — gitignored personal overrides
 *
 * Usage:
 *   with-env --app <app-name> [--env <environment>] -- <command...>
 *
 * Example:
 *   with-env --app frontend -- yarn frontend dev
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ParsedArgs {
  app: string;
  env: string;
  command: string[];
}

// ── Args parsing ──

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let app = '';
  let env = 'local';
  let commandStart = -1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      commandStart = i + 1;
      break;
    }
    if (args[i] === '--app' && args[i + 1]) {
      app = args[i + 1]!;
      i++;
    } else if (args[i] === '--env' && args[i + 1]) {
      env = args[i + 1]!;
      i++;
    }
  }

  if (!app || commandStart < 0 || commandStart >= args.length) {
    console.error('Usage: with-env --app <app-name> [--env <environment>] -- <command...>');
    process.exit(1);
  }

  return { app, env, command: args.slice(commandStart) };
}

// ── .env parser ──

export function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      // Quoted: strip the matching pair; anything inside (incl. `#`) is literal.
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline ` #…` is a trailing comment, not part of the value
      // (matches dotenv). Guards the `SERVICE_DOMAIN=host # note` footgun.
      const hashIndex = value.indexOf(' #');
      if (hashIndex >= 0) {
        value = value.slice(0, hashIndex).trimEnd();
      }
    }
    result[key] = value;
  }
  return result;
}

export function mergeEnv(base: Record<string, string>, override: Record<string, string>): Record<string, string> {
  return { ...base, ...override };
}

// ── File loading (I/O shell — untested) ──

function loadFile(filePath: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(filePath, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(`[with-env] failed to read ${filePath}, skipping:`, err);
    }
    return {};
  }
}

// ── Main ──

function main(): void {
  const { app, env, command } = parseArgs(process.argv);

  // Script lives at infra/local/scripts/ — repo root is 3 levels up.
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = resolve(scriptDir, '..', '..', '..');
  const envDir = resolve(repoRoot, 'packages', app, 'env');

  const base = loadFile(resolve(envDir, `.env.${env}`));
  const override = loadFile(resolve(envDir, '.env'));
  const merged = mergeEnv(base, override);

  console.error(
    `[with-env] app=${app} env=${env} (.env.${env}: ${Object.keys(base).length} vars, .env: ${Object.keys(override).length} vars)`,
  );

  // A single pre-joined string (not args-array) with shell:true — Node deprecates
  // (DEP0190) passing an args array alongside shell:true, and it would print a
  // warning on every dev command. Call sites are trusted plain-token package.json
  // scripts, so the join is safe.
  const child = spawn(command.join(' '), {
    stdio: 'inherit',
    env: { ...process.env, ...merged },
    shell: true,
  });

  child.on('exit', code => {
    process.exit(code ?? 0);
  });
}

// Only run when executed directly (tsx infra/local/scripts/with-env.ts …),
// not when imported by tests. Compare via pathToFileURL so a checkout path with
// spaces/special chars (which import.meta.url percent-encodes) still matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
