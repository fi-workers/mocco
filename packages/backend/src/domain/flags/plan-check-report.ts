// The flags plan check on a pull request (#146), the pure part: what merging would do
// with `.mocco/flags.yml` → a Markdown report. Per project: the flags it creates, takes
// over and hands back, then each environment's changes and whether they apply at once or
// wait for approval. A refused file lists its issues instead. The report never blocks a
// merge: it ends `success` when every project has a plan and `neutral` when any refuses.
import { FLAGS_FILE_PATH } from '@mocco/common/flags-file';

import { CheckConclusions } from '@backend/domain/integration/ports';

import type { FlagsFileIssue, FlagsSyncPlan, FlagsSyncPlanResult } from '@backend/domain/flags/flags-file';
import type { CheckReport } from '@backend/domain/integration/ports';
import type { ChangeOp, Clause, RolloutEntry, Rule, Serve } from '@mocco/common/flags';
import type { GateRequirements } from '@mocco/common/governance';

/** The check's name on the pull request. */
export const FLAGS_PLAN_CHECK_NAME = 'Mocco flags plan';

export interface PlanCheckEnvironment {
  key: string;
  name: string;
  /** What a change here waits for; null when it applies at once. */
  changeGate: GateRequirements | null;
}

export interface PlanCheckProject {
  name: string;
  environments: readonly PlanCheckEnvironment[];
  /** The plan against the project as it is now, or the issues that refuse the file. */
  result: FlagsSyncPlanResult;
}

export interface PlanCheckInput {
  headSha: string;
  projects: readonly PlanCheckProject[];
}

/** Text safe inside a Markdown table cell: one line, pipes escaped. */
/* eslint-disable sonarjs/null-dereference -- false positives: `text` is a non-optional string and split() yields strings only */
const cell = (text: string): string =>
  text
    .split('\n')
    .map(line => line.trim())
    .join(' ')
    .replaceAll('|', String.raw`\|`);
/* eslint-enable sonarjs/null-dereference */

const code = (text: string | number): string => `\`${String(text).replaceAll('`', "'")}\``;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

const listOf = (items: readonly string[]): string => items.map(item => code(item)).join(', ');

function rolloutOf(entries: readonly RolloutEntry[]): string {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  return entries
    .map(entry => `${code(entry.variant)} ${total === 0 ? 0 : Math.round((entry.weight / total) * 1000) / 10}%`)
    .join(' / ');
}

const serveOf = (serve: Serve): string =>
  'variant' in serve ? code(serve.variant) : `a rollout of ${rolloutOf(serve.rollout)}`;

const clauseOf = (clause: Clause): string => {
  if ('segment' in clause) {
    return `${clause.negate ? 'not in' : 'in'} segment ${code(clause.segment)}`;
  }
  return `${code(clause.attribute)} ${clause.op} ${clause.values.map(value => code(value)).join(', ')}`;
};

const ruleOf = (rule: Rule): string =>
  `when ${rule.clauses.map(clause => clauseOf(clause)).join(' and ')}, serve ${serveOf(rule.serve)}`;

/** One op, said in words; a rule list adds one line per rule. */
interface OpWords {
  text: string;
  rules?: string[];
}

function describeOp(op: ChangeOp): OpWords {
  switch (op.op) {
    case 'set_enabled': {
      return { text: op.enabled ? 'turn on' : 'turn off' };
    }
    case 'set_default_variant': {
      return { text: `serve ${code(op.variant)} by default` };
    }
    case 'set_off_variant': {
      return { text: `serve ${code(op.variant)} when off or killed` };
    }
    case 'set_rollout': {
      return {
        text: op.rollout === null ? 'stop the default rollout' : `roll out ${rolloutOf(op.rollout)} by default`,
      };
    }
    case 'set_rules': {
      return op.rules.length === 0
        ? { text: 'remove every rule' }
        : { text: `set ${plural(op.rules.length, 'rule')}`, rules: op.rules.map(rule => ruleOf(rule)) };
    }
    case 'add_flag': {
      return { text: `add, serving ${code(op.defaultVariant)}` };
    }
    case 'kill': {
      return { text: 'kill' };
    }
    case 'restore': {
      return { text: 'restore' };
    }
    case 'set_segment': {
      return { text: `set segment ${code(op.segmentKey)}` };
    }
    case 'delete_segment': {
      return { text: `delete segment ${code(op.segmentKey)}` };
    }
    default: {
      return { text: 'change' };
    }
  }
}

const flagKeyOf = (op: ChangeOp): string => ('flagKey' in op ? op.flagKey : '');

/** An environment's ops, grouped by flag in the order they first appear. */
function opLines(ops: readonly ChangeOp[]): string[] {
  const keys = [...new Set(ops.map(op => flagKeyOf(op)))];
  return keys.flatMap(key => {
    const words = ops.filter(op => flagKeyOf(op) === key).map(op => describeOp(op));
    const rules = words.flatMap(word => word.rules ?? []);
    return [
      `- ${key === '' ? 'Segments' : code(key)}: ${words.map(word => word.text).join('; ')}`,
      ...rules.map((rule, index) => `  ${index + 1}. ${rule}`),
    ];
  });
}

const approvalOf = (gate: GateRequirements): string => {
  const roles = gate.resume.map(entry => `${entry.count} × ${code(entry.role)}`).join(' and ');
  return `Waits for approval (${roles}${gate.prevent_self ? ', not by its proposers' : ''})`;
};

function issuesTable(issues: readonly FlagsFileIssue[]): string[] {
  return [
    '| Where | Problem |',
    '|---|---|',
    ...issues.map(issue => {
      const where = issue.path === '' ? 'the file' : code(issue.path);
      const line = issue.line === undefined ? '' : ` (line ${issue.line})`;
      return `| ${where}${line} | ${cell(issue.message)} |`;
    }),
  ];
}

function definitionLines(plan: FlagsSyncPlan): string[] {
  return [
    ...plan.creations.map(
      creation =>
        `- Creates ${code(creation.key)} (${creation.type}, variants ${listOf(Object.keys(creation.variants))}), starting off in every environment`,
    ),
    ...plan.definitionUpdates.map(update => {
      const changes = [
        ...(update.description === undefined ? [] : ['description']),
        ...(update.lifecycle === undefined ? [] : [`lifecycle → ${update.lifecycle}`]),
        ...(update.clientVisible === undefined
          ? []
          : [update.clientVisible ? 'visible to browsers and apps' : 'hidden from browsers and apps']),
        ...(update.addedVariants === undefined ? [] : [`adds variants ${listOf(Object.keys(update.addedVariants))}`]),
      ];
      return `- Updates ${code(update.key)}: ${changes.join(', ')}`;
    }),
    ...plan.adopted.map(key => `- Takes over ${code(key)} from the console (read-only there from now on)`),
    ...plan.released.map(key => `- Hands ${code(key)} back to the console, turned off everywhere`),
  ];
}

const changeCount = (plan: FlagsSyncPlan): number => plan.changes.reduce((sum, change) => sum + change.ops.length, 0);

const isEmptyPlan = (plan: FlagsSyncPlan): boolean =>
  plan.creations.length === 0 &&
  plan.definitionUpdates.length === 0 &&
  plan.adopted.length === 0 &&
  plan.released.length === 0 &&
  plan.changes.length === 0;

/** The environments a plan changes that wait for approval. */
const gatedOf = (project: PlanCheckProject, plan: FlagsSyncPlan): PlanCheckEnvironment[] =>
  project.environments.filter(
    environment =>
      environment.changeGate !== null && plan.changes.some(change => change.environmentKey === environment.key),
  );

/** One project's line in the summary table. */
function outcomeOf(project: PlanCheckProject): string {
  const { plan, issues } = project.result;
  if (plan === null) {
    return `Refused: ${plural(issues.length, 'issue')}`;
  }
  if (isEmptyPlan(plan)) {
    return 'No changes';
  }
  const gated = gatedOf(project, plan);
  return [
    ...(plan.creations.length > 0 ? [plural(plan.creations.length, 'new flag')] : []),
    `${plural(changeCount(plan), 'change')} in ${plural(plan.changes.length, 'environment')}`,
    ...(gated.length > 0 ? [`${gated.map(environment => environment.name).join(', ')} waits for approval`] : []),
  ].join(' · ');
}

function environmentSection(project: PlanCheckProject, plan: FlagsSyncPlan): string[] {
  if (plan.changes.length === 0) {
    return ['No environment changes.'];
  }
  const byKey = new Map(project.environments.map(environment => [environment.key, environment]));
  const rows = plan.changes.map(change => {
    const environment = byKey.get(change.environmentKey);
    const name =
      environment === undefined ? code(change.environmentKey) : `${cell(environment.name)} (${code(environment.key)})`;
    const applies =
      environment === undefined || environment.changeGate === null ? 'At once' : approvalOf(environment.changeGate);
    return `| ${name} | ${change.ops.length} | ${applies} |`;
  });
  const details = plan.changes.flatMap(change => [
    '',
    `#### ${byKey.get(change.environmentKey)?.name ?? change.environmentKey}`,
    '',
    ...opLines(change.ops),
  ]);
  return ['| Environment | Changes | Applies |', '|---|---|---|', ...rows, ...details];
}

function projectSection(project: PlanCheckProject): string[] {
  const { plan, issues } = project.result;
  const heading = `## ${project.name}`;
  if (plan === null) {
    return [
      heading,
      '',
      `The file is refused, so merging changes nothing in ${project.name}:`,
      '',
      ...issuesTable(issues),
    ];
  }
  if (isEmptyPlan(plan)) {
    return [heading, '', `${project.name} already matches the file.`];
  }
  const definitions = definitionLines(plan);
  return [
    heading,
    ...(definitions.length > 0 ? ['', '### Flags', '', ...definitions] : []),
    '',
    '### Environments',
    '',
    ...environmentSection(project, plan),
  ];
}

function titleOf(projects: readonly PlanCheckProject[]): string {
  const refused = projects.filter(project => project.result.plan === null);
  if (refused.length > 0) {
    const issues = refused.reduce((sum, project) => sum + project.result.issues.length, 0);
    return `${FLAGS_FILE_PATH} is refused: ${plural(issues, 'issue')}`;
  }
  const plans = projects.flatMap(project =>
    project.result.plan === null ? [] : [{ project, plan: project.result.plan }],
  );
  const changes = plans.reduce((sum, { plan }) => sum + changeCount(plan), 0);
  const environments = plans.reduce((sum, { plan }) => sum + plan.changes.length, 0);
  const definitions = plans.reduce((sum, { plan }) => sum + definitionLines(plan).length, 0);
  if (changes === 0) {
    return definitions === 0 ? 'No flag changes' : plural(definitions, 'flag definition change');
  }
  const gated = plans.reduce((sum, { project, plan }) => sum + gatedOf(project, plan).length, 0);
  return [
    `${plural(changes, 'change')} in ${plural(environments, 'environment')}`,
    ...(gated > 0 ? [`${gated} waiting for approval`] : []),
  ].join(', ');
}

/** The check report for a pull request's `.mocco/flags.yml`. */
export function renderPlanCheck(input: PlanCheckInput): CheckReport {
  const isRefused = input.projects.some(project => project.result.plan === null);
  const summary = [
    `What merging this pull request does with ${code(FLAGS_FILE_PATH)} at ${code(input.headSha.slice(0, 7))}:`,
    '',
    '| Project | On merge |',
    '|---|---|',
    ...input.projects.map(project => `| ${cell(project.name)} | ${cell(outcomeOf(project))} |`),
    '',
    'Planned against each project as it is now; the merge plans again. This check never blocks a merge.',
  ].join('\n');
  const text = input.projects.map(project => projectSection(project).join('\n')).join('\n\n');
  return {
    name: FLAGS_PLAN_CHECK_NAME,
    headSha: input.headSha,
    conclusion: isRefused ? CheckConclusions.neutral : CheckConclusions.success,
    title: titleOf(input.projects),
    summary,
    text,
  };
}
