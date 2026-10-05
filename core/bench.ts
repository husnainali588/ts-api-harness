// harness bench (spec §5.6): a baseline run (fetchers + compaction disabled) and an actual run of the same task on
// the same driver; tokens/<runId>.json is computed only from the two runs' ledgers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { findDriver, loadRegistry } from './registry.js';
import { runHarness, type RunOptions } from './loop.js';
import { loadTask } from './task.js';
import { redact } from './redact.js';

const LedgerFile = z.object({
  runId: z.string(),
  taskSha256: z.string(),
  driver: z.string(),
  baseline: z.boolean(),
  completed: z.boolean(),
  stoppedBy: z.string(),
  transports: z.array(z.string()),
  servedBy: z.array(z.string()),
  turns: z.array(z.object({ turn: z.number(), inputTokens: z.number(), outputTokens: z.number(), source: z.string() })),
  mechanisms: z.record(z.string(), z.number()),
});
type LedgerFile = z.infer<typeof LedgerFile>;

export function readLedger(repoRoot: string, runId: string): LedgerFile {
  const path = join(repoRoot, 'runs', runId, 'tokens.json');
  if (!existsSync(path)) throw new Error(`run ${runId} has no tokens.json`);
  return LedgerFile.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const pct = (actual: number, baseline: number) => (baseline <= 0 ? 0 : Math.round((1 - actual / baseline) * 1000) / 10);

function side(l: LedgerFile, turns: LedgerFile['turns']) {
  const total = turns.reduce((n, t) => n + t.inputTokens, 0);
  return {
    runId: l.runId,
    completed: l.completed,
    stoppedBy: l.stoppedBy,
    turns: turns.map((t) => ({ turn: t.turn, inputTokens: t.inputTokens, outputTokens: t.outputTokens })),
    totalInputTokens: total,
    meanInputTokensPerTurn: turns.length === 0 ? 0 : Math.round(total / turns.length),
    peakInputTokens: turns.reduce((m, t) => Math.max(m, t.inputTokens), 0),
  };
}

/** Builds the token report from two ledgers; per-turn numbers use the aligned turns 1..N only. */
export function tokenReport(taskPath: string, baseline: LedgerFile, actual: LedgerFile, baselineCapped: boolean) {
  const n = Math.min(baseline.turns.length, actual.turns.length);
  const b = baseline.turns.slice(0, n);
  const a = actual.turns.slice(0, n);
  const bAll = side(baseline, baseline.turns);
  const aAll = side(actual, actual.turns);
  const bAligned = side(baseline, b);
  const aAligned = side(actual, a);
  const provider = [...baseline.turns, ...actual.turns].every((t) => t.source === 'provider');
  const meanPerTurn = pct(aAligned.meanInputTokensPerTurn, bAligned.meanInputTokensPerTurn);
  return {
    task: taskPath,
    taskSha256: actual.taskSha256,
    driver: actual.driver,
    transport: actual.transports.filter((t) => t !== 'local').join(', ') || 'local',
    servedBy: actual.servedBy,
    measuredFrom: provider ? 'provider usage: input tokens incl. cached' : 'ESTIMATE (scripted/replay driver, chars/4) — not evidence',
    evidence: provider,
    baseline: { ...bAll, ...(baselineCapped ? { completed: false, stoppedBy: 'baseline turn cap (cost)' } : {}) },
    actual: aAll,
    perTurn: b.map((t, i) => ({ turn: t.turn, baseline: t.inputTokens, actual: a[i]?.inputTokens ?? 0, reductionPct: pct(a[i]?.inputTokens ?? 0, t.inputTokens) })),
    reductionPct: {
      meanPerTurn,
      total: pct(aAligned.totalInputTokens, bAligned.totalInputTokens),
      peak: pct(aAligned.peakInputTokens, bAligned.peakInputTokens),
    },
    targetPct: 90,
    met: meanPerTurn > 90,
    mechanisms: actual.mechanisms,
    ...(n < actual.turns.length || n < baseline.turns.length
      ? { note: `perTurn and reductionPct are computed over the aligned turns 1..${n} only (baseline ${baseline.turns.length} turns${baselineCapped ? ', capped for cost' : ''}, actual ${actual.turns.length} turns); no full-run claim is made from a capped baseline.` }
      : {}),
  };
}

export interface BenchOptions extends Omit<RunOptions, 'baseline' | 'maxTurns'> {
  baselineTurns?: number;
  actualRun?: string;
  maxTurns?: number;
  /** Allow a local (scripted/replay) driver; the report is then marked as an estimate, never evidence. */
  offline?: boolean;
}

export async function bench(opts: BenchOptions): Promise<{ path: string; report: ReturnType<typeof tokenReport> }> {
  const registry = await loadRegistry(opts.harnessRoot);
  const def = findDriver(registry, opts.driverId).def;
  if (def.envKeys.length === 0 && opts.offline !== true) {
    throw new Error(`bench refuses the local driver "${def.id}" for evidence (its tokens are estimates); pass --offline for a non-evidence estimate`);
  }
  const task = loadTask(opts.taskPath, opts.repoRoot);
  let actual: LedgerFile;
  if (opts.actualRun !== undefined) {
    actual = readLedger(opts.repoRoot, opts.actualRun);
    if (actual.taskSha256 !== task.sha256) throw new Error(`--actual-run ${opts.actualRun} ran a different task (sha256 mismatch)`);
    if (actual.driver !== def.id) throw new Error(`--actual-run ${opts.actualRun} used driver "${actual.driver}", not "${def.id}"`);
    if (actual.baseline) throw new Error(`--actual-run ${opts.actualRun} is a baseline run`);
  } else {
    const run = await runHarness({ ...opts, baseline: false });
    actual = readLedger(opts.repoRoot, run.runId);
  }
  const capped = opts.baselineTurns !== undefined;
  const baselineRun = await runHarness({ ...opts, baseline: true, ...(capped ? { maxTurns: opts.baselineTurns } : {}) });
  const baseline = readLedger(opts.repoRoot, baselineRun.runId);
  const report = tokenReport(task.path, baseline, actual, capped && baseline.turns.length >= (opts.baselineTurns ?? 0));
  const dir = join(opts.repoRoot, 'tokens');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${actual.runId}.json`);
  writeFileSync(path, `${redact(JSON.stringify(report, null, 2))}\n`);
  return { path, report };
}
