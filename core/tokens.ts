// Token ledger (spec §5.6): one entry per turn from the driver's normalised usage.
import type { Usage } from './driver.js';

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
