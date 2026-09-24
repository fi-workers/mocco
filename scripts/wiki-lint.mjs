#!/usr/bin/env node
// Mechanical checks for the docs/ llm-wiki (`yarn docs:lint`). The rules it enforces are
// docs/meta/schema.md (frontmatter) and docs/meta/conventions.md (links); keep the three in sync.
// Any error exits 1. docs/prototype/ is a throwaway click-through, not part of the wiki.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');
const SKIP_DIRS = new Set([join(DOCS, 'prototype')]);
const INDEX = join(DOCS, 'index.md');
const ADR_INDEX = join(DOCS, 'adr/README.md');

const REQUIRED = ['title', 'type', 'status', 'created', 'updated', 'confidence', 'owner', 'tags'];
const OPTIONAL = ['description', 'related'];
const TYPE_KEYS = {
  adr: ['decision_date', 'supersedes', 'superseded_by', 'stakeholders'],
  journal: ['session', 'commits'],
  spec: ['phase', 'target_date', 'implements'],
  reference: ['code_refs'],
};
// okf_version is declared once, on the bundle's entry point (see docs/README.md).
const FILE_KEYS = { [INDEX]: ['okf_version'] };
const ENUMS = {
  type: ['adr', 'journal', 'guide', 'reference', 'concept', 'overview', 'spec', 'meta', 'research'],
  status: ['draft', 'active', 'accepted', 'superseded', 'evergreen', 'stale', 'archived'],
  confidence: ['high', 'medium', 'low'],
};
const DATE_KEYS = ['created', 'updated', 'decision_date', 'target_date'];
const LIST_KEYS = [
  'tags',
  'related',
  'code_refs',
  'implements',
  'supersedes',
  'superseded_by',
  'stakeholders',
  'commits',
];
// Keys whose entries are paths relative to the document itself / to the repo root.
const DOC_PATH_KEYS = ['related', 'implements', 'supersedes', 'superseded_by'];
const REPO_PATH_KEYS = ['code_refs'];

const errors = [];
const rel = path => relative(ROOT, path);

function walk(dir) {
  if (SKIP_DIRS.has(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return walk(path);
    }
    return name.endsWith('.md') ? [path] : [];
  });
}

const unquote = value => value.replace(/^(["'])(.*)\1$/, '$2');

// The wiki's frontmatter uses three shapes only: `key: value`, `key: [a, b]`, and `key:` followed by
// `  - item` lines. Anything else is reported rather than guessed at.
function parseFrontmatter(text, where) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    return null;
  }
  const data = {};
  let listKey = null;
  match[1].split('\n').forEach(line => {
    if (!line.trim() || line.trim().startsWith('#')) {
      return;
    }
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      data[listKey].push(unquote(item[1].trim()));
      return;
    }
    const pair = line.match(/^(\w+):\s*(.*)$/);
    if (!pair) {
      errors.push(`${where}: unparseable frontmatter line: ${line}`);
      return;
    }
    const [, key, value] = pair;
    if (key in data) {
      errors.push(`${where}: duplicate key ${key}`);
    }
    if (value === '') {
      data[key] = [];
      listKey = key;
      return;
    }
    listKey = null;
    data[key] = value.startsWith('[')
      ? value
          .slice(1, -1)
          .split(',')
          .map(v => unquote(v.trim()))
          .filter(Boolean)
      : unquote(value.trim());
  });
  return { data, body: text.slice(match[0].length) };
}

// Links inside code are examples, not links.
const stripCode = text => text.replaceAll(/```[\s\S]*?```/g, '').replaceAll(/`[^`\n]*`/g, '');

function localTarget(link) {
  if (/^[a-z][\w+.-]*:/i.test(link) || link.startsWith('#')) {
    return null;
  }
  return link.split('#')[0].split('?')[0];
}

const bodyLinks = body =>
  [...stripCode(body).matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(m => m[1]).filter(localTarget);

const docs = walk(DOCS).toSorted();
const linksByFile = new Map();

docs.forEach(path => {
  const where = rel(path);
  const text = readFileSync(path, 'utf8');
  const parsed = parseFrontmatter(text, where);
  if (!parsed) {
    errors.push(`${where}: no frontmatter`);
    linksByFile.set(path, bodyLinks(text));
    return;
  }
  const { data: meta, body } = parsed;

  REQUIRED.filter(key => meta[key] === undefined || meta[key].length === 0).forEach(key =>
    errors.push(`${where}: missing required key ${key}`),
  );
  Object.entries(ENUMS)
    .filter(([key, allowed]) => meta[key] !== undefined && !allowed.includes(meta[key]))
    .forEach(([key, allowed]) => errors.push(`${where}: ${key} "${meta[key]}" is not one of ${allowed.join(' | ')}`));
  DATE_KEYS.filter(key => meta[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(meta[key])).forEach(key =>
    errors.push(`${where}: ${key} is not YYYY-MM-DD`),
  );
  if (meta.created && meta.updated && meta.updated < meta.created) {
    errors.push(`${where}: updated is earlier than created`);
  }
  if (meta.tags !== undefined && !Array.isArray(meta.tags)) {
    errors.push(`${where}: tags must be a list`);
  }

  const allowed = new Set([...REQUIRED, ...OPTIONAL, ...(TYPE_KEYS[meta.type] ?? []), ...(FILE_KEYS[path] ?? [])]);
  Object.keys(meta)
    .filter(key => !allowed.has(key))
    .forEach(key => errors.push(`${where}: key ${key} is not allowed for type ${meta.type} (see docs/meta/schema.md)`));
  if (meta.status === 'superseded' && !meta.superseded_by) {
    errors.push(`${where}: status superseded needs superseded_by`);
  }

  const list = key => [meta[key] ?? []].flat();
  DOC_PATH_KEYS.flatMap(key => list(key).map(target => [key, target]))
    .filter(([, target]) => localTarget(target) && !existsSync(join(dirname(path), localTarget(target))))
    .forEach(([key, target]) => errors.push(`${where}: ${key} points to a missing file → ${target}`));
  REPO_PATH_KEYS.flatMap(key => list(key).map(target => [key, target]))
    .filter(([, target]) => !existsSync(join(ROOT, target)))
    .forEach(([key, target]) => errors.push(`${where}: ${key} path does not exist → ${target}`));
  LIST_KEYS.filter(key => meta[key] !== undefined && typeof meta[key] === 'string' && meta[key].includes(',')).forEach(
    key => errors.push(`${where}: ${key} looks like a list; use [a, b] or "- item" lines`),
  );

  linksByFile.set(path, bodyLinks(body));
});

linksByFile.forEach((links, path) => {
  links
    .filter(link => !existsSync(join(dirname(path), localTarget(link))))
    .forEach(link => errors.push(`${rel(path)}: broken link → ${link}`));
});

// Every ADR must be reachable from the top-level MOC and from the ADR index.
const adrs = docs.filter(path => /^\d{4}-.+\.md$/.test(relative(join(DOCS, 'adr'), path)));
[INDEX, ADR_INDEX].forEach(indexPath => {
  if (!existsSync(indexPath)) {
    errors.push(`${rel(indexPath)}: missing`);
    return;
  }
  const linked = new Set((linksByFile.get(indexPath) ?? []).map(link => join(dirname(indexPath), localTarget(link))));
  adrs.filter(adr => !linked.has(adr)).forEach(adr => errors.push(`${rel(indexPath)}: does not link ${rel(adr)}`));
});

errors.forEach(error => console.log(`error ${error}`));
console.log(`\n${docs.length} docs · ${errors.length} errors`);
process.exit(errors.length > 0 ? 1 : 0);
