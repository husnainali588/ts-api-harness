// Standards check runner (spec §5.7): every rule plugin, one line per rule per file, a summary, a verdict.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import fg from 'fast-glob';
import { Project } from 'ts-morph';
import { exec, execTool } from './exec.js';
import { redact } from './redact.js';
import type { Registry } from './registry.js';
import type { RuleContext, RuleDefinition, RuleFailure } from './sdk.js';
import type { Task } from './task.js';
import { mappedTests } from './tests.js';

export type RuleStatus = 'pass' | 'fail' | 'n/a' | 'unproven';

export interface RuleOutcome {
  id: string;
  description: string;
  unit: string;
  required: boolean;
  mode: 'ratio' | 'count';
  status: RuleStatus;
  checked: number;
  failing: number;
  reason?: string;
  files: { file: string; checked: number; failures: RuleFailure[] }[];
}

export interface CheckReport {
  runId: string;
  api: string;
  rules: RuleOutcome[];
  verdictPct: number;
  green: boolean;
  unproven: string[];
  text: string;
  reportDir: string;
}

const W_RULE = 18;
const W_STATUS = 10;
const W_LOC = 34;
const pad = (s: string, w: number) => (s.length >= w ? `${s} ` : s.padEnd(w));
const label = (s: RuleStatus) => (s === 'fail' ? 'FAIL' : s === 'unproven' ? 'UNPROVEN' : s);

async function ensureInstalled(apiRoot: string): Promise<string | undefined> {
  if (existsSync(join(apiRoot, 'node_modules'))) return undefined;
  if (!existsSync(join(apiRoot, 'package-lock.json'))) return 'node_modules missing and no package-lock.json to install from';
  const res = await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: apiRoot, timeoutMs: 600_000 });
  return res.code === 0 ? undefined : `npm ci --ignore-scripts failed (exit ${res.code})`;
}

function loadProject(apiRoot: string): Project {
  const tsconfig = join(apiRoot, 'tsconfig.json');
  if (existsSync(tsconfig)) return new Project({ tsConfigFilePath: tsconfig });
  const project = new Project({ compilerOptions: { strict: true } });
  project.addSourceFilesAtPaths(join(apiRoot, 'src/**/*.ts'));
  return project;
}

async function runRule(rule: RuleDefinition, ctx: RuleContext, apiRoot: string): Promise<RuleOutcome> {
  const base = { id: rule.id, description: rule.description, unit: rule.unit, required: rule.required, mode: rule.summary ?? 'ratio' } as const;
  let files: RuleOutcome['files'] = [];
  try {
    if (rule.checkProject !== undefined) {
      const result = await rule.checkProject(ctx);
      if ('unproven' in result) return { ...base, status: 'unproven', checked: 0, failing: 0, reason: result.unproven, files: [] };
      files = result.files.map((f) => ({ file: f.file, checked: f.checked, failures: f.failures }));
    } else if (rule.check !== undefined) {
      const paths = (await fg([...rule.files], { cwd: apiRoot, onlyFiles: true, ignore: ['**/node_modules/**'] })).sort();
      for (const rel of paths) {
        const abs = join(apiRoot, rel);
        const sf = ctx.project.getSourceFile(abs) ?? ctx.project.addSourceFileAtPath(abs);
        const result = await rule.check(sf, ctx);
        files.push({ file: rel, checked: result.checked, failures: result.failures });
      }
    }
  } catch (error) {
    return { ...base, status: 'unproven', checked: 0, failing: 0, reason: `rule crashed: ${error instanceof Error ? error.message : String(error)}`, files };
  }
  const checked = files.reduce((n, f) => n + f.checked, 0);
  const failing = files.reduce((n, f) => n + f.failures.length, 0);
  const status: RuleStatus = failing > 0 ? 'fail' : checked === 0 ? 'n/a' : 'pass';
  return { ...base, status, checked, failing, files };
}

function render(outcomes: RuleOutcome[], verdictPct: number, green: boolean): string {
  const lines: string[] = [];
  for (const o of outcomes) {
    if (o.status === 'unproven') {
      lines.push(`${pad(o.id, W_RULE)}${pad('UNPROVEN', W_STATUS)}${o.reason ?? ''}`);
      continue;
    }
    if (o.status === 'n/a') {
      lines.push(`${pad(o.id, W_RULE)}${pad('n/a', W_STATUS)}${pad(`(no ${o.unit})`, W_LOC)}0 ${o.unit}`);
      continue;
    }
    for (const f of o.files) {
      if (f.failures.length === 0) {
        if (f.checked === 0) continue;
        const detail = o.mode === 'count' ? `0 ${o.unit}` : `${f.checked}/${f.checked} ${o.unit}`;
        lines.push(`${pad(o.id, W_RULE)}${pad('pass', W_STATUS)}${pad(f.file, W_LOC)}${detail}`);
        continue;
      }
      for (const fail of f.failures) {
        const loc = `${f.file}:${fail.line}${fail.col === undefined ? '' : `:${fail.col}`}`;
        lines.push(`${pad(o.id, W_RULE)}${pad('FAIL', W_STATUS)}${pad(loc, W_LOC)}${fail.message}${fail.fix === undefined ? '' : ` → ${fail.fix}`}`);
      }
    }
  }
  lines.push('─'.repeat(60));
  for (const o of outcomes) {
    let detail: string;
    if (o.status === 'unproven') detail = o.reason ?? 'could not run';
    else if (o.mode === 'count') detail = `${String(o.failing).padStart(2)} ${o.unit}`;
    else detail = `${Math.max(0, o.checked - o.failing)}/${o.checked} ${o.unit}`;
    lines.push(`${pad(o.id, W_RULE)}${pad(label(o.status), W_STATUS)}${detail}${o.required ? '' : ' (optional)'}`);
  }
  const failing = outcomes.filter((o) => o.required && (o.status === 'fail' || o.status === 'unproven')).map((o) => o.id);
  lines.push(`${pad('verdict', W_RULE)}${pad(`${verdictPct}%`, W_STATUS)}→ ${green ? 'all rules pass' : `not green: ${failing.join(', ')}`}`);
  return lines.join('\n');
}

export async function runChecks(opts: {
  apiRoot: string;
  registry: Registry;
  runId: string;
  reportsRoot: string;
  task?: Task;
  saveRaw?: (label: string, content: string) => string;
}): Promise<CheckReport> {
  if (!existsSync(opts.apiRoot)) throw new Error(`API path not found: ${opts.apiRoot}`);
  const apiRoot = realpathSync(resolve(opts.apiRoot));
  const installError = await ensureInstalled(apiRoot);
  const rules = opts.registry.rules.map((r) => r.def);
  let outcomes: RuleOutcome[];
  if (installError !== undefined) {
    outcomes = rules.map((r) => ({ id: r.id, description: r.description, unit: r.unit, required: r.required, mode: r.summary ?? 'ratio', status: 'unproven', checked: 0, failing: 0, reason: installError, files: [] }));
  } else {
    const project = loadProject(apiRoot);
    const ctx: RuleContext = {
      apiRoot,
      project,
      checker: project.getTypeChecker(),
      exec: (file, args, o) => execTool(file, args, { cwd: apiRoot, ...o }),
      ...(opts.task === undefined ? {} : { task: opts.task }),
      rel: (sf) => relative(apiRoot, sf.getFilePath()).split('\\').join('/'),
      mappedTests: (source) => mappedTests(apiRoot, source),
      saveRaw: opts.saveRaw ?? ((_label, content) => content.slice(0, 0)),
    };
    outcomes = [];
    for (const rule of rules) outcomes.push(await runRule(rule, ctx, apiRoot));
  }
  const counted = outcomes.filter((o) => o.required && o.status !== 'n/a');
  const passing = counted.filter((o) => o.status === 'pass').length;
  const verdictPct = counted.length === 0 ? 100 : Math.floor((passing / counted.length) * 100);
  const unproven = outcomes.filter((o) => o.status === 'unproven').map((o) => `${o.id}: ${o.reason ?? 'unproven'}`);
  const green = passing === counted.length && !outcomes.some((o) => o.required && o.status === 'unproven');
  const text = render(outcomes, verdictPct, green);
  const reportDir = join(opts.reportsRoot, 'reports', opts.runId);
  mkdirSync(reportDir, { recursive: true });
  const api = isAbsolute(opts.apiRoot) ? relative(opts.reportsRoot, apiRoot) || '.' : opts.apiRoot;
  writeFileSync(join(reportDir, 'standards.txt'), `${redact(text)}\n`);
  writeFileSync(join(reportDir, 'standards.json'), `${redact(JSON.stringify({ runId: opts.runId, api, verdictPct, green, unproven, rules: outcomes }, null, 2))}\n`);
  return { runId: opts.runId, api, rules: outcomes, verdictPct, green, unproven, text, reportDir };
}

/** Compact text for the model: failing lines first (capped), then the summary block. */
export function compactReport(report: CheckReport, maxFailLines = 12): string {
  const lines = report.text.split('\n');
  const summaryStart = lines.findIndex((l) => l.startsWith('─'));
  const fails = lines.slice(0, summaryStart).filter((l) => / FAIL | UNPROVEN /.test(l));
  const summary = lines.slice(summaryStart + 1);
  const shown = fails.slice(0, maxFailLines);
  const more = fails.length > maxFailLines ? [`… ${fails.length - maxFailLines} more failing lines`] : [];
  return [...shown, ...more, ...(shown.length > 0 ? ['─'.repeat(20)] : []), ...summary].join('\n');
}
