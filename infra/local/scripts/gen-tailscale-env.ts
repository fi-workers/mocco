#!/usr/bin/env tsx
/**
 * The ONLY Tailscale-aware code in this repo.
 *
 * Reads `tailscale status --json`, extracts the local machine's tailnet
 * DNS name (`Self.DNSName`), and upserts it as `SERVICE_DOMAIN` into
 * `packages/frontend/env/.env` (the gitignored personal-override file —
 * see `with-env.ts`).
 *
 * Usage:
 *   yarn env:tailscale
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── Pure parts (test seam) ──

export function dnsNameFromStatus(json: unknown): string {
  const self = isRecord(json) && isRecord(json.Self) ? json.Self : undefined;
  const dnsName = self?.DNSName;

  if (typeof dnsName !== 'string' || dnsName.length === 0) {
    throw new Error('tailscale Self.DNSName missing — is tailscale up? run: tailscale status');
  }

  return dnsName.endsWith('.') ? dnsName.slice(0, -1) : dnsName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function upsertEnvLine(content: string, key: string, value: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(`^\\s*${escapedKey}=`);
  const line = `${key}=${value}`;

  const lines = content.length > 0 ? content.split('\n') : [];
  // Drop the trailing empty element produced by a trailing newline, so
  // we don't accumulate blank lines across repeated upserts.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const index = lines.findIndex(l => keyPattern.test(l));
  if (index >= 0) {
    lines[index] = line;
  } else {
    lines.push(line);
  }

  return `${lines.join('\n')}\n`;
}

// ── I/O shell (untested) ──

function readStatus(): unknown {
  let raw: string;
  try {
    raw = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  } catch (err) {
    throw new Error(
      `failed to run "tailscale status --json" — is tailscale installed and on PATH? (${(err as Error).message})`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse tailscale status JSON: ${(err as Error).message}`);
  }
}

function main(): void {
  const host = dnsNameFromStatus(readStatus());

  // Script lives at infra/local/scripts/ — repo root is 3 levels up.
  const scriptDir = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = resolve(scriptDir, '..', '..', '..');
  const envPath = resolve(repoRoot, 'packages', 'frontend', 'env', '.env');

  let existing = '';
  try {
    existing = readFileSync(envPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  const next = upsertEnvLine(existing, 'SERVICE_DOMAIN', host);
  writeFileSync(envPath, next);

  console.log(`SERVICE_DOMAIN=${host} -> packages/frontend/env/.env`);
}

// Only run when executed directly (tsx infra/local/scripts/gen-tailscale-env.ts),
// not when imported by tests. Compare via pathToFileURL so a checkout path with
// spaces/special chars (which import.meta.url percent-encodes) still matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
