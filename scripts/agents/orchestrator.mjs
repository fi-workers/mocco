#!/usr/bin/env node
// Issue-driven agent orchestrator. Operating guide: docs/guides/agent-orchestration.md; rules: WORKFLOW.md.
//
//   node scripts/agents/orchestrator.mjs triage [--dry-run]   Sentry → GitHub issues
//   node scripts/agents/orchestrator.mjs work [--issue N]     process agent:ready issues one at a time
//   node scripts/agents/orchestrator.mjs daily                triage, then work (called by launchd)
//
// Common option: --ref <git ref>  where WORKFLOW.md and prompts are read from and the triage workspace is
//   checked out (default origin/<default branch>)
//
// Follows the Symphony SPEC, but runs once and exits instead of staying resident. State lives only in
// GitHub labels and workspace folders, so if a run dies midway the next run picks it up.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '../..');
const RUN_MARKER = '<!-- agent-run';
const LABEL = {
  ready: 'agent:ready',
  inProgress: 'agent:in-progress',
  verifying: 'agent:verifying',
  review: 'agent:human-review',
  blocked: 'agent:blocked',
  rework: 'agent:rework',
};

// ── Process helpers ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const flag = name => args.includes(`--${name}`);
const option = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// The default branch comes from origin/HEAD; tracker.base_branch in WORKFLOW.md overrides it.
let base = 'main';
let ref;
const today = new Date().toISOString().slice(0, 10);
// The log location is set from the repo name after WORKFLOW.md is read (~/Library/Logs/agents/<repo>).
let logRoot;
let logDir;

function initLogs(repoName) {
  logRoot = join(homedir(), 'Library/Logs/agents', repoName);
  logDir = join(logRoot, today);
  mkdirSync(logDir, { recursive: true });
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (logRoot) writeFileSync(join(logRoot, 'orchestrator.log'), `${line}\n`, { flag: 'a' });
}

function run(cmd, cmdArgs, { cwd = REPO, input, allowFail = false } = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed (${result.status})\n${result.stderr || result.stdout}`);
  }
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

const git = (gitArgs, opts) => run('git', gitArgs, opts);
const gh = (ghArgs, opts) => run('gh', ghArgs, opts);
const ghJson = ghArgs => JSON.parse(gh(ghArgs).out || 'null');
const shell = (script, cwd) => run('bash', ['-lc', script], { cwd, allowFail: true });
const expandHome = path => path.replace(/^~(?=\/|$)/, homedir());

// ── WORKFLOW.md ────────────────────────────────────────────────────────────

// The WORKFLOW.md front matter uses "key: value", indentation nesting, and arrays. A key may also be a path (`src/app/`).
// Arrays may be one line "[a, b]", multi-line "[\n  a,\n  b,\n]" (prettier rewrites long arrays this way), or "- a" lists.
function parseFrontmatter(yaml) {
  // Join multi-line flow arrays into one line.
  const text = yaml.replace(/:\s*\n\s*\[([^\]]*)\]/g, (_, inner) => `: [${inner.replace(/\s*\n\s*/g, ' ')}]`);
  const root = {};
  const stack = [{ indent: -1, node: root, key: null, parent: null }];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const item = line.trim().match(/^-\s+(.*)$/);
    if (item) {
      // Turn the "key:" opened just above (an empty map) into an array.
      const top = stack.at(-1);
      if (top.parent && !Array.isArray(top.parent[top.key])) top.parent[top.key] = [];
      top.parent?.[top.key]?.push(scalar(item[1].trim()));
      continue;
    }
    const [, key, value] = line.trim().match(/^([^\s:][^:]*?):\s*(.*)$/) ?? [];
    if (!key) continue;
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).node;
    if (value === '') {
      parent[key] = {};
      stack.push({ indent, node: parent[key], key, parent });
    } else if (value.startsWith('[')) {
      parent[key] = value
        .slice(1, value.lastIndexOf(']'))
        .split(',')
        .map(v => v.trim())
        .filter(Boolean)
        .map(scalar);
    } else {
      parent[key] = scalar(value);
    }
  }
  return root;
}

function scalar(value) {
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

function readAtRef(path) {
  return git(['show', `${ref}:${path}`]).out;
}

function loadWorkflow() {
  const text = readAtRef('WORKFLOW.md');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('WORKFLOW.md front matter (---) not found');
  return { config: parseFrontmatter(match[1]), template: match[2] };
}

// Strict rendering, like Symphony: an unknown variable is an error.
function render(template, vars) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = path.split('.').reduce((obj, key) => obj?.[key], vars);
    if (value === undefined) throw new Error(`Unknown template variable: ${path}`);
    return String(value);
  });
}

// ── Lock ───────────────────────────────────────────────────────────────────

function acquireLock(root) {
  const path = join(root, '.lock');
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    try {
      process.kill(pid, 0);
      log(`Another run (pid ${pid}) is in progress; exiting`);
      process.exit(0);
    } catch {
      log(`Removed stale lock (pid ${pid})`);
    }
  }
  writeFileSync(path, String(process.pid));
  const release = () => rmSync(path, { force: true });
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
}

// ── Claude run ────────────────────────────────────────────────────────────

function runClaude({ cwd, prompt, allowed, disallowed, budget, timeoutMinutes, name }) {
  const logFile = join(logDir, `${name}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.jsonl`);
  const fd = openSync(logFile, 'w');
  const cliArgs = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--max-budget-usd',
    String(budget),
    '--allowedTools',
    ...allowed,
    '--disallowedTools',
    ...disallowed,
  ];
  log(`claude run: ${name} (budget $${budget}, limit ${timeoutMinutes} min) → ${logFile}`);
  const result = spawnSync('claude', cliArgs, {
    cwd,
    input: prompt,
    stdio: ['pipe', fd, fd],
    timeout: timeoutMinutes * 60_000,
  });
  closeSync(fd);
  const final = readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(event => event?.type === 'result')
    .at(-1);
  return {
    ok: result.status === 0 && final?.is_error !== true,
    timedOut: result.error?.code === 'ETIMEDOUT',
    summary: final?.result ?? '',
    cost: final?.total_cost_usd,
    logFile,
  };
}

// ── Workspaces ───────────────────────────────────────────────────────────

function requireAtRef(path) {
  if (!git(['cat-file', '-e', `${ref}:${path}`], { allowFail: true }).ok) {
    throw new Error(`${path} not found at ${ref}. Check that the orchestration PR is merged`);
  }
}

function preflight(config) {
  if (config.sentry) requireAtRef(config.sentry.prompt);
  if (config.wiki?.index) requireAtRef(config.wiki.index);
}

function ensureTriageWorkspace(root) {
  const path = join(root, 'triage');
  if (!existsSync(path)) {
    git(['worktree', 'add', '--detach', path, ref]);
  } else {
    git(['checkout', '--detach', '--force', ref], { cwd: path });
    git(['clean', '-fd'], { cwd: path });
  }
  return path;
}

function ensureIssueWorkspace(root, config, number) {
  const path = join(root, `issue-${number}`);
  const branch = `agent/${number}`;
  // Marks that after_create finished successfully. If setup dies midway only the folder remains, so the
  // hook reruns when the marker is missing. Kept outside the worktree so the agent never commits it.
  const readyMarker = join(root, `.ready-issue-${number}`);
  if (!existsSync(path)) {
    rmSync(readyMarker, { force: true });
    const remote = git(['ls-remote', '--heads', 'origin', branch]).out;
    if (remote) {
      git(['fetch', 'origin', branch, '--quiet']);
      git(['worktree', 'add', '-B', branch, path, `origin/${branch}`]);
    } else {
      git(['worktree', 'add', '-B', branch, path, `origin/${base}`]);
    }
  }
  const createHook = config.hooks?.after_create;
  if (createHook && !existsSync(readyMarker)) {
    log(`after_create: ${createHook}`);
    const result = shell(createHook, path);
    if (!result.ok) throw new Error(`after_create failed\n${result.err.slice(-2000)}`);
  }
  writeFileSync(readyMarker, new Date().toISOString());
  const hook = config.hooks?.before_run;
  if (hook) {
    const result = shell(hook, path);
    if (!result.ok) {
      shell('git merge --abort 2>/dev/null; git rebase --abort 2>/dev/null; true', path);
      throw new Error(`before_run failed (possible conflict with main)\n${result.err.slice(-2000)}`);
    }
  }
  return { path, branch };
}

// ── GitHub labels ────────────────────────────────────────────────────────────

// Remove only labels actually on the issue. Asking gh to remove a missing label fails the add too.
function setLabel(repo, number, from, to) {
  const current = ghJson(['issue', 'view', String(number), '--repo', repo, '--json', 'labels']).labels.map(l => l.name);
  const edit = ['issue', 'edit', String(number), '--repo', repo, '--add-label', to];
  for (const label of [].concat(from).filter(l => l && l !== to && current.includes(l)))
    edit.push('--remove-label', label);
  gh(edit);
}

function comment(repo, number, body) {
  gh(['issue', 'comment', String(number), '--repo', repo, '--body', body]);
}

function agentLabels(issue) {
  return issue.labels.map(l => l.name).filter(name => name.startsWith('agent:'));
}

// ── triage ─────────────────────────────────────────────────────────────────

const TRIAGE_ALLOWED = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'Bash(sentry issue list:*)',
  'Bash(sentry issue view:*)',
  'Bash(sentry issue events:*)',
  'Bash(sentry issue resolve:*)',
  'Bash(gh issue:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(mkdir:*)',
  'Bash(ls:*)',
  'Bash(jq:*)',
  'Bash(head:*)',
];
const TRIAGE_DISALLOWED = [
  'Bash(gh issue close:*)',
  'Bash(gh issue delete:*)',
  'Bash(gh issue transfer:*)',
  'Bash(gh issue lock:*)',
  'Bash(sentry issue archive:*)',
  'Bash(sentry issue merge:*)',
  'Bash(sentry issue unresolve:*)',
];
const TRIAGE_WRITES = [
  'Bash(gh issue create:*)',
  'Bash(gh issue edit:*)',
  'Bash(gh issue reopen:*)',
  'Bash(gh issue comment:*)',
  'Bash(sentry issue resolve:*)',
];

function triage({ config, root }) {
  const dryRun = flag('dry-run');
  const cwd = ensureTriageWorkspace(root);
  const mode = dryRun
    ? '**This is a dry run.** Do not create or edit GitHub issues and do not change Sentry state. Only print what each step would do, in the step-5 report format.'
    : 'This is a live run.';
  const prompt = render(readAtRef(config.sentry.prompt), { ...config, today, mode });
  const result = runClaude({
    cwd,
    prompt,
    allowed: TRIAGE_ALLOWED,
    disallowed: dryRun ? [...TRIAGE_DISALLOWED, ...TRIAGE_WRITES] : TRIAGE_DISALLOWED,
    budget: config.sentry.max_budget_usd,
    timeoutMinutes: config.sentry.timeout_minutes,
    name: dryRun ? 'triage-dry' : 'triage',
  });
  log(
    `triage ${result.ok ? 'done' : 'failed'}${result.cost ? ` ($${result.cost.toFixed(2)})` : ''}\n${result.summary}`,
  );
  return result;
}

// ── work ───────────────────────────────────────────────────────────────────

const WORK_ALLOWED = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Skill', 'TodoWrite'];
// Block pushes to the default branch by its actual name (not every repo uses main).
// Extra per-repo blocks go in WORKFLOW.md agent.disallowed_tools (e.g. deploy scripts, docker, ssh).
function workDisallowed(config) {
  return [
    ...WORK_DISALLOWED,
    `Bash(git push origin ${base}:*)`,
    `Bash(git push origin HEAD:${base}:*)`,
    ...(config.agent.disallowed_tools ?? []),
  ];
}

const WORK_DISALLOWED = [
  'Bash(vercel:*)',
  'Bash(npx vercel:*)',
  'Bash(yarn vercel:*)',
  'Bash(git push --force:*)',
  'Bash(git push -f:*)',
  'Bash(git push origin main:*)',
  'Bash(git push origin HEAD:main:*)',
  'Bash(gh pr merge:*)',
  'Bash(gh issue close:*)',
  'Bash(gh issue delete:*)',
  'Bash(gh repo:*)',
  'Bash(gh release:*)',
  'Bash(eas:*)',
  'Bash(npx eas:*)',
  'Bash(yarn @fw/app deploy:*)',
  'Bash(yarn @fw/app submit:*)',
  'Bash(yarn @fw/app build:*)',
  'Bash(sentry issue resolve:*)',
  'Bash(sentry issue archive:*)',
  'Bash(sentry issue merge:*)',
];

function attemptCount(repo, number) {
  const issue = ghJson(['issue', 'view', String(number), '--repo', repo, '--json', 'comments']);
  return issue.comments.filter(c => c.body.includes(RUN_MARKER)).length;
}

// Independent of the agent's own report, the orchestrator reruns the checks for the changed paths.
// What to run comes from WORKFLOW.md: verify.by_path (path prefix → command list) and verify.always.
function independentCheck(config, path) {
  const changed = git(['diff', '--name-only', `origin/${base}...HEAD`], { cwd: path })
    .out.split('\n')
    .filter(Boolean);
  const byPath = Object.entries(config.verify?.by_path ?? {});
  const matched = byPath
    .filter(([prefix]) => changed.some(file => file.startsWith(prefix)))
    .flatMap(([, cmds]) => cmds);
  const steps = [...new Set([...matched, ...(config.verify?.always ?? [])])];
  const failures = [];
  for (const step of steps) {
    const result = shell(step, path);
    log(`verify ${result.ok ? 'passed' : 'failed'}: ${step}`);
    if (!result.ok) failures.push({ step, output: `${result.out}\n${result.err}`.trim().slice(-3000) });
  }
  return { changed, steps, failures };
}

function pickIssues(repo, config) {
  const excluded = new Set(config.tracker.exclude_labels ?? []);
  if (option('issue')) {
    const issue = ghJson(['issue', 'view', option('issue'), '--repo', repo, '--json', 'number,title,body,labels']);
    const hit = issue.labels.map(l => l.name).filter(name => excluded.has(name));
    if (hit.length > 0 && !flag('force')) {
      throw new Error(`#${issue.number} has excluded label(s) (${hit.join(', ')}). Pass --force to run it anyway`);
    }
    return [issue];
  }
  const list = label =>
    ghJson([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--label',
      label,
      '--json',
      'number,title,body,labels',
      '--limit',
      '50',
    ]);
  // tracker.exclude_labels: issues carrying one of these labels are skipped even when agent:ready
  // (e.g. deploy or live-data work)
  const active = config.tracker.active_states
    .flatMap(label => list(label).sort((a, b) => a.number - b.number))
    .filter(issue => !issue.labels.some(l => excluded.has(l.name)));
  const seen = new Set();
  return active
    .filter(issue => !seen.has(issue.number) && seen.add(issue.number))
    .slice(0, config.agent.max_issues_per_run);
}

// An in-progress issue with no lock held means a previous run died midway. Return it so it can be picked again.
function reconcile(repo) {
  const stale = ghJson([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--label',
    LABEL.inProgress,
    '--json',
    'number',
  ]);
  for (const { number } of stale) {
    log(`#${number}: left unfinished by a previous run; returned to ready`);
    setLabel(repo, number, [LABEL.inProgress, LABEL.verifying], LABEL.ready);
  }
}

function workOne({ config, root, template }, issue) {
  const repo = config.tracker.repo;
  const number = issue.number;
  const from = agentLabels(issue);
  const attempt = attemptCount(repo, number) + 1;

  if (attempt > config.agent.max_attempts) {
    log(`#${number}: exceeded ${config.agent.max_attempts} attempts; blocked`);
    setLabel(repo, number, from, LABEL.blocked);
    comment(
      repo,
      number,
      `The agent could not finish after ${config.agent.max_attempts} attempts, so it is stopping. Improve the issue, then move it back to \`agent:ready\`. To reset the attempt count, delete the \`agent-run\` comments.`,
    );
    return 'blocked';
  }

  log(`#${number} start (attempt ${attempt}): ${issue.title}`);
  setLabel(repo, number, from, LABEL.inProgress);

  let workspace;
  try {
    workspace = ensureIssueWorkspace(root, config, number);
  } catch (error) {
    log(`#${number}: workspace setup failed — ${error.message}`);
    setLabel(repo, number, LABEL.inProgress, LABEL.blocked);
    comment(
      repo,
      number,
      `${RUN_MARKER}:attempt=${attempt} -->\nStopping: the workspace could not be prepared.\n\n\`\`\`\n${error.message.slice(-1500)}\n\`\`\``,
    );
    return 'blocked';
  }

  comment(
    repo,
    number,
    `${RUN_MARKER}:attempt=${attempt} -->\nThe agent is starting work (attempt ${attempt}/${config.agent.max_attempts}, branch \`${workspace.branch}\`).`,
  );
  const prompt = render(template, { ...config, issue, attempt });
  const result = runClaude({
    cwd: workspace.path,
    prompt,
    allowed: WORK_ALLOWED,
    disallowed: workDisallowed(config),
    budget: config.agent.max_budget_usd,
    timeoutMinutes: config.agent.timeout_minutes,
    name: `issue-${number}`,
  });
  log(
    `#${number}: claude ${result.ok ? 'exited' : result.timedOut ? 'timed out' : 'failed'}${result.cost ? ` ($${result.cost.toFixed(2)})` : ''}`,
  );

  const after = agentLabels(ghJson(['issue', 'view', String(number), '--repo', repo, '--json', 'labels']));
  if (after.includes(LABEL.blocked)) return 'blocked';

  if (!after.includes(LABEL.review)) {
    setLabel(repo, number, after, LABEL.blocked);
    comment(
      repo,
      number,
      `The agent finished without opening a PR${result.timedOut ? ' (timed out)' : ''}. Log: \`${result.logFile}\`\n\n${result.summary.slice(0, 2000)}`,
    );
    return 'blocked';
  }

  const pr = ghJson([
    'pr',
    'list',
    '--repo',
    repo,
    '--head',
    workspace.branch,
    '--state',
    'open',
    '--json',
    'number,url',
  ])?.[0];
  if (!pr) {
    setLabel(repo, number, after, LABEL.blocked);
    comment(
      repo,
      number,
      `The label is human-review, but no open PR was found for branch \`${workspace.branch}\`. Log: \`${result.logFile}\``,
    );
    return 'blocked';
  }

  const check = independentCheck(config, workspace.path);
  if (check.failures.length > 0) {
    setLabel(repo, number, after, LABEL.rework);
    const details = check.failures.map(f => `**${f.step}**\n\`\`\`\n${f.output}\n\`\`\``).join('\n\n');
    gh([
      'pr',
      'comment',
      String(pr.number),
      '--repo',
      repo,
      '--body',
      `The orchestrator's independent verification failed. The agent will fix it on the next run.\n\n${details}`,
    ]);
    return 'rework';
  }
  setLabel(repo, number, after, LABEL.review);
  gh([
    'pr',
    'comment',
    String(pr.number),
    '--repo',
    repo,
    '--body',
    `Orchestrator independent verification passed: ${check.steps.map(s => `\`${s}\``).join(', ')}`,
  ]);
  log(`#${number}: PR ${pr.url} awaiting review`);
  return 'review';
}

function work(ctx) {
  const repo = ctx.config.tracker.repo;
  if (!option('issue')) reconcile(repo);
  // agent.sequential: pick no new issue while any agent PR is open (for repos that land PRs one at a time)
  if (ctx.config.agent.sequential === 'true' || ctx.config.agent.sequential === true) {
    const open = ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,headRefName']).filter(pr =>
      pr.headRefName.startsWith('agent/'),
    );
    if (open.length > 0) {
      log(`Stopping: agent PR(s) still open: ${open.map(pr => `#${pr.number}`).join(', ')}`);
      return [];
    }
  }
  const issues = pickIssues(repo, ctx.config);
  if (issues.length === 0) {
    log('No issues to process');
    return [];
  }
  return issues.map(issue => {
    try {
      return { number: issue.number, outcome: workOne(ctx, issue) };
    } catch (error) {
      log(`#${issue.number}: exception — ${error.stack}`);
      setLabel(repo, issue.number, [LABEL.inProgress, LABEL.verifying], LABEL.blocked);
      return { number: issue.number, outcome: 'error' };
    }
  });
}

// ── Entry point ─────────────────────────────────────────────────────────────────

let notifyTitle = 'Agents';

function notify(message) {
  run(
    'osascript',
    ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(notifyTitle)}`],
    { allowFail: true },
  );
}

function main() {
  if (!['triage', 'work', 'daily'].includes(command)) {
    console.log('Usage: orchestrator.mjs <triage|work|daily> [--dry-run] [--issue N] [--ref <git ref>]');
    process.exit(1);
  }
  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  if (head.ok) base = head.out.replace(/^origin\//, '');
  ref = option('ref') ?? `origin/${base}`;
  git(['fetch', 'origin', base, '--quiet']);
  requireAtRef('WORKFLOW.md');
  const { config, template } = loadWorkflow();
  if (config.tracker.base_branch) base = config.tracker.base_branch;
  // tracker.gh_user: when the repo is visible only to another gh account. Both the orchestrator's and the
  // agent's gh use this token.
  if (config.tracker.gh_user) process.env.GH_TOKEN = run('gh', ['auth', 'token', '--user', config.tracker.gh_user]).out;
  initLogs(config.tracker.repo.split('/')[1]);
  notifyTitle = `${config.name ?? config.tracker.repo} agents`;
  preflight(config);
  const root = expandHome(config.workspace.root);
  mkdirSync(root, { recursive: true });
  acquireLock(root);
  const ctx = { config, template, root };

  log(`── ${command} start (ref ${ref})`);
  const summary = [];
  if (command === 'triage' && !config.sentry) throw new Error('WORKFLOW.md has no sentry section');
  if ((command === 'triage' || command === 'daily') && config.sentry) {
    summary.push(`triage ${triage(ctx).ok ? 'done' : 'failed'}`);
  }
  if (command === 'work' || command === 'daily') {
    const results = work(ctx);
    summary.push(results.length ? results.map(r => `#${r.number} ${r.outcome}`).join(', ') : 'no issues to work on');
  }
  log(`── ${command} end: ${summary.join(' · ')}`);
  notify(summary.join(' · '));
}

try {
  main();
} catch (error) {
  log(`Aborted: ${error.message}`);
  notify(`Aborted: ${error.message.split('\n')[0]}`);
  process.exit(1);
}
