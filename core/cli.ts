// harness run | bench | check | ship | plugins | doctor   (spec §4)
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { exec } from './exec.js';
import { bench } from './bench.js';
import { runChecks } from './checks.js';
import { newRunId, runHarness } from './loop.js';
import { loadRegistry, type Registry } from './registry.js';
import { ship, type ShipResult } from './ship.js';
import { loadTask } from './task.js';

export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage: harness <command> [options]

  run     --task <file> --driver <id> [--baseline] [--ship] [--max-turns N] [--max-run-tokens N] [--total-budget N] [--script <file>]
  bench   --task <file> --driver <id> [--baseline-turns N] [--actual-run <runId>] [--max-run-tokens N] [--total-budget N] [--offline --script <file>]
  check   --api <path> [--task <file>]
  ship    --run <runId>
  plugins                 list discovered drivers, tools, hooks, rules and context fetchers
  doctor                  environment check (prints env variable names, never values)`;

export type Command = (args: string[], io: Io) => Promise<number>;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const stdio: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export function loadDotEnv(root: string = HARNESS_ROOT): 'loaded' | 'missing' | 'skipped' {
  if (process.env.HARNESS_NO_DOTENV === '1') return 'skipped';
  const path = join(root, '.env');
  if (!existsSync(path)) return 'missing';
  process.loadEnvFile(path);
  return 'loaded';
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}

export async function pluginsCommand(_args: string[], io: Io, root: string = HARNESS_ROOT): Promise<number> {
  const registry = await loadRegistry(root);
  printRegistry(registry, io);
  return 0;
}

export function printRegistry(registry: Registry, io: Io): void {
  const section = (title: string, rows: { id: string; source: string; text: string }[]) => {
    io.out(`${title} (${rows.length})`);
    for (const row of rows) io.out(`  ${pad(row.id, 22)}${pad(row.source, 44)}${row.text}`);
  };
  section('drivers', registry.drivers.map((d) => ({ id: d.def.id, source: d.source, text: d.def.description })));
  section('tools', registry.tools.map((t) => ({ id: t.def.name, source: t.source, text: t.def.description })));
  section('hooks', registry.hooks.map((h) => ({ id: h.def.id, source: h.source, text: `${h.def.phase}, order ${h.def.order}` })));
  section('rules', registry.rules.map((r) => ({ id: r.def.id, source: r.source, text: `${r.def.required ? 'required' : 'optional'}, unit: ${r.def.unit}` })));
  section('context', registry.contexts.map((c) => ({ id: c.def.name, source: c.source, text: c.def.description })));
}

export async function doctorCommand(_args: string[], io: Io, root: string = HARNESS_ROOT): Promise<number> {
  let ok = true;
  const dotenv = loadDotEnv(root);
  const major = Number(process.versions.node.split('.')[0]);
  const nodeOk = major >= 22;
  ok &&= nodeOk;
  io.out(`${pad('node', 12)}v${process.versions.node} ${nodeOk ? '(ok, need >= 22)' : '(TOO OLD, need >= 22)'}`);

  const git = await exec('git', ['--version']);
  ok &&= git.code === 0;
  io.out(`${pad('git', 12)}${git.code === 0 ? git.stdout.trim() : 'MISSING'}`);

  const gh = await exec('gh', ['--version']);
  if (gh.code === 0) {
    const auth = await exec('gh', ['auth', 'status'], { keepSecrets: true });
    io.out(`${pad('gh', 12)}${gh.stdout.split('\n')[0] ?? 'gh'} (${auth.code === 0 ? 'authenticated' : 'NOT authenticated — ship will be unproven'})`);
  } else {
    io.out(`${pad('gh', 12)}MISSING — ship will be unproven`);
  }

  io.out(`${pad('.env', 12)}${dotenv}`);
  const registry = await loadRegistry(root);
  for (const { def } of registry.drivers) {
    const set = def.envKeys.filter((name) => (process.env[name] ?? '') !== '');
    const status =
      def.envKeys.length === 0
        ? 'ready (no key needed)'
        : set.length > 0
          ? `ready — set: ${set.join(', ')}`
          : `no key — set one of: ${def.envKeys.join(', ')}`;
    io.out(`${pad(`driver ${def.id}`, 20)}${status}`);
    for (const name of def.envVars) {
      io.out(`${pad('', 20)}${name} ${(process.env[name] ?? '') !== '' ? 'set' : 'not set'}`);
    }
  }
  for (const name of ['HARNESS_MAX_RUN_TOKENS', 'HARNESS_TOTAL_BUDGET']) {
    io.out(`${pad(name, 24)}${(process.env[name] ?? '') !== '' ? 'set' : 'not set'}`);
  }
  return ok ? 0 : 1;
}

export function intFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer, got "${value}"`);
  return n;
}

export async function runCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      task: { type: 'string' },
      driver: { type: 'string' },
      baseline: { type: 'boolean', default: false },
      ship: { type: 'boolean', default: false },
      'max-turns': { type: 'string' },
      'max-run-tokens': { type: 'string' },
      'total-budget': { type: 'string' },
      script: { type: 'string' },
    },
  });
  if (values.task === undefined || values.driver === undefined) throw new Error('run needs --task <file> and --driver <id>');
  loadDotEnv();
  const taskPath = relative(HARNESS_ROOT, resolve(process.cwd(), values.task));
  const maxTurns = intFlag(values['max-turns'], 'max-turns');
  // CLI flags override env values (the local .env may hold older, higher limits).
  const maxRunTokens = intFlag(values['max-run-tokens'], 'max-run-tokens') ?? intFlag(process.env.HARNESS_MAX_RUN_TOKENS, 'HARNESS_MAX_RUN_TOKENS');
  const totalBudget = intFlag(values['total-budget'], 'total-budget') ?? intFlag(process.env.HARNESS_TOTAL_BUDGET, 'HARNESS_TOTAL_BUDGET');
  const summary = await runHarness({
    harnessRoot: HARNESS_ROOT,
    repoRoot: HARNESS_ROOT,
    taskPath,
    driverId: values.driver,
    baseline: values.baseline,
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxRunTokens === undefined ? {} : { maxRunTokens }),
    ...(totalBudget === undefined ? {} : { totalBudget }),
    ...(values.script === undefined ? {} : { script: resolve(process.cwd(), values.script) }),
    log: (line) => io.out(line),
  });
  const t = summary.tokens;
  io.out(`status     ${summary.status.toUpperCase()} — ${summary.reason}`);
  io.out(`evidence   runs/${summary.runId}/ (branch ${summary.branch})`);
  io.out(`tokens     input ${t.totalInputTokens}, output ${t.totalOutputTokens}, ${t.turns} turns, peak ${t.peakInputTokens} (${t.source})`);
  const c = summary.cost;
  io.out(`model      requested ${c.requestedModel ?? '(local)'}, served ${summary.servedBy.join(', ') || '-'} via ${summary.transports.join(', ') || '-'}`);
  io.out(`spend      ${c.paid ? `paid — run cap ${c.cap ?? 'none'}, ledger ${c.spentBefore} → ${c.spentAfter} input tokens` : 'free (not counted)'}`);
  if (values.ship && summary.status === 'green') return printShip(await ship({ repoRoot: HARNESS_ROOT, runId: summary.runId, log: (l) => io.out(l) }), io);
  if (values.ship) io.out('ship       not attempted: the run is not green');
  return summary.status === 'green' ? 0 : 1;
}

function printShip(result: ShipResult, io: Io): number {
  io.out(`ship       ${result.status.toUpperCase()} — ${result.reason}${result.prUrl === undefined ? '' : ` — ${result.prUrl}`}`);
  return result.status === 'shipped' ? 0 : 1;
}

export async function shipCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { run: { type: 'string' } } });
  if (values.run === undefined) throw new Error('ship needs --run <runId>');
  loadDotEnv();
  return printShip(await ship({ repoRoot: HARNESS_ROOT, runId: values.run, log: (l) => io.out(l) }), io);
}

export async function checkCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { api: { type: 'string' }, task: { type: 'string' } } });
  if (values.api === undefined) throw new Error('check needs --api <path>');
  const registry = await loadRegistry(HARNESS_ROOT);
  const task = values.task === undefined ? undefined : loadTask(values.task, process.cwd());
  const report = await runChecks({
    apiRoot: resolve(process.cwd(), values.api),
    registry,
    runId: `check-${newRunId()}`,
    reportsRoot: HARNESS_ROOT,
    ...(task === undefined ? {} : { task }),
  });
  io.out(report.text);
  io.out(`report     ${relative(process.cwd(), join(report.reportDir, 'standards.txt'))}`);
  return report.green ? 0 : 1;
}

export async function benchCommand(args: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      task: { type: 'string' },
      driver: { type: 'string' },
      'baseline-turns': { type: 'string' },
      'actual-run': { type: 'string' },
      'max-turns': { type: 'string' },
      'max-run-tokens': { type: 'string' },
      'total-budget': { type: 'string' },
      script: { type: 'string' },
      offline: { type: 'boolean', default: false },
    },
  });
  if (values.task === undefined || values.driver === undefined) throw new Error('bench needs --task <file> and --driver <id>');
  loadDotEnv();
  const maxRunTokens = intFlag(values['max-run-tokens'], 'max-run-tokens') ?? intFlag(process.env.HARNESS_MAX_RUN_TOKENS, 'HARNESS_MAX_RUN_TOKENS');
  const totalBudget = intFlag(values['total-budget'], 'total-budget') ?? intFlag(process.env.HARNESS_TOTAL_BUDGET, 'HARNESS_TOTAL_BUDGET');
  const baselineTurns = intFlag(values['baseline-turns'], 'baseline-turns');
  const maxTurns = intFlag(values['max-turns'], 'max-turns');
  const { path, report } = await bench({
    harnessRoot: HARNESS_ROOT,
    repoRoot: HARNESS_ROOT,
    taskPath: relative(HARNESS_ROOT, resolve(process.cwd(), values.task)),
    driverId: values.driver,
    offline: values.offline,
    ...(baselineTurns === undefined ? {} : { baselineTurns }),
    ...(values['actual-run'] === undefined ? {} : { actualRun: values['actual-run'] }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxRunTokens === undefined ? {} : { maxRunTokens }),
    ...(totalBudget === undefined ? {} : { totalBudget }),
    ...(values.script === undefined ? {} : { script: resolve(process.cwd(), values.script) }),
    log: (line) => io.out(line),
  });
  io.out(`baseline   ${report.baseline.totalInputTokens} input tokens over ${report.baseline.turns.length} turns (mean ${report.baseline.meanInputTokensPerTurn})`);
  io.out(`actual     ${report.actual.totalInputTokens} input tokens over ${report.actual.turns.length} turns (mean ${report.actual.meanInputTokensPerTurn})`);
  io.out(`reduction  mean/turn ${report.reductionPct.meanPerTurn}%, total ${report.reductionPct.total}%, peak ${report.reductionPct.peak}% — target >${report.targetPct}%: ${report.met ? 'MET' : 'NOT MET'}`);
  io.out(`measured   ${report.measuredFrom}`);
  if (report.note !== undefined) io.out(`note       ${report.note}`);
  io.out(`report     ${relative(process.cwd(), path)}`);
  return report.met && report.evidence ? 0 : 1;
}

const COMMANDS: Record<string, Command> = {
  ship: (args, io) => shipCommand(args, io),
  bench: (args, io) => benchCommand(args, io),
  check: (args, io) => checkCommand(args, io),
  plugins: (args, io) => pluginsCommand(args, io),
  doctor: (args, io) => doctorCommand(args, io),
  run: (args, io) => runCommand(args, io),
};

export function registerCommand(name: string, command: Command): void {
  COMMANDS[name] = command;
}

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h') {
    io.out(USAGE);
    return name === undefined ? 2 : 0;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    io.err(`unknown command "${name}"\n\n${USAGE}`);
    return 2;
  }
  try {
    return await command(rest, io);
  } catch (error) {
    io.err(`harness ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

