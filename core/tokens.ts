// Token ledger (spec §5.6): one entry per turn from the driver's normalised usage.
// Spend ledger (spec §1.10): cumulative input tokens of paid live runs, enforced in code.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Usage } from './driver.js';

export const MIN_REMAINING_TO_START = 20_000;
export const DEFAULT_MAX_RUN_TOKENS = 400_000;

/** A model costs money unless it is local (no model id) or an explicitly free gateway variant. */
export function isPaidModel(model: string | undefined): boolean {
  return model !== undefined && !model.endsWith(':free');
}

const SpendFile = z.object({
  totalInputTokens: z.number().default(0),
  runs: z
    .array(z.object({ runId: z.string(), driver: z.string(), model: z.string(), inputTokens: z.number(), outputTokens: z.number(), updated: z.string() }))
    .default([]),
});
export type SpendFile = z.infer<typeof SpendFile>;

export class SpendLedger {
  constructor(readonly path: string) {}

  read(): SpendFile {
    if (!existsSync(this.path)) return SpendFile.parse({});
    return SpendFile.parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  spent(): number {
    return this.read().totalInputTokens;
  }

  /** Adds one paid turn to a run's entry; written immediately so a crash cannot lose spend. */
  add(entry: { runId: string; driver: string; model: string; inputTokens: number; outputTokens: number }): void {
    const data = this.read();
    const run = data.runs.find((r) => r.runId === entry.runId);
    const updated = new Date().toISOString();
    if (run === undefined) data.runs.push({ ...entry, updated });
    else {
      run.inputTokens += entry.inputTokens;
      run.outputTokens += entry.outputTokens;
      run.updated = updated;
    }
    data.totalInputTokens += entry.inputTokens;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(data, null, 2)}\n`);
  }
}

/** Effective cap for one run: the smaller of the per-run cap and what the total budget has left. */
export function effectiveCap(perRun: number, totalBudget: number | undefined, spent: number): { cap: number; remaining: number | undefined } {
  if (totalBudget === undefined) return { cap: perRun, remaining: undefined };
  const remaining = Math.max(0, totalBudget - spent);
  return { cap: Math.min(perRun, remaining), remaining };
}

export interface LedgerTurn {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  source: Usage['source'];
}

export interface LedgerTotals {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanInputTokensPerTurn: number;
  peakInputTokens: number;
  source: Usage['source'] | 'mixed' | 'none';
}

export class TokenLedger {
  readonly turns: LedgerTurn[] = [];

  record(turn: number, usage: Usage): void {
    this.turns.push({ turn, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, source: usage.source });
  }

  totalInput(): number {
    return this.turns.reduce((n, t) => n + t.inputTokens, 0);
  }

  totals(): LedgerTotals {
    const input = this.totalInput();
    const sources = new Set(this.turns.map((t) => t.source));
    return {
      turns: this.turns.length,
      totalInputTokens: input,
      totalOutputTokens: this.turns.reduce((n, t) => n + t.outputTokens, 0),
      meanInputTokensPerTurn: this.turns.length === 0 ? 0 : Math.round(input / this.turns.length),
      peakInputTokens: this.turns.reduce((m, t) => Math.max(m, t.inputTokens), 0),
      source: sources.size === 0 ? 'none' : sources.size > 1 ? 'mixed' : (this.turns[0]?.source ?? 'none'),
    };
  }
}
