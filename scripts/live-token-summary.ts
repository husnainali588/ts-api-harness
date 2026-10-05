// Collects the real, provider-measured token numbers of every live run under runs/ (from each run's own
// runs/<id>/tokens.json ledger) into tokens/live-runs.json. No baseline exists for these runs, so no reduction is
// claimed; per-turn input shows how the actual context behaved live.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Ledger {
  runId: string;
  driver: string;
  baseline: boolean;
  completed: boolean;
  stoppedBy: string;
  servedBy: string[];
  transports: string[];
  turns: { turn: number; inputTokens: number; outputTokens: number; source: string }[];
}

const runs = readdirSync('runs')
  .filter((d) => existsSync(join('runs', d, 'tokens.json')))
  .sort()
  .map((d): Ledger => JSON.parse(readFileSync(join('runs', d, 'tokens.json'), 'utf8')))
  .filter((l) => l.turns.length > 0 && l.turns.every((t) => t.source === 'provider'));

const report = {
  measuredFrom: 'provider usage: input tokens incl. cached (live runs only)',
  evidence: true,
  note: 'Actual-mode live runs only; no live baseline was run (budget), so no reduction percentage is claimed from these.',
  runs: runs.map((l) => {
    const input = l.turns.reduce((n, t) => n + t.inputTokens, 0);
    return {
      runId: l.runId,
      driver: l.driver,
      servedBy: l.servedBy,
      transport: l.transports.join(', '),
      outcome: l.completed ? 'green' : l.stoppedBy,
      turns: l.turns.length,
      totalInputTokens: input,
      totalOutputTokens: l.turns.reduce((n, t) => n + t.outputTokens, 0),
      meanInputTokensPerTurn: Math.round(input / l.turns.length),
      peakInputTokens: Math.max(...l.turns.map((t) => t.inputTokens)),
      perTurnInput: l.turns.map((t) => t.inputTokens),
    };
  }),
};
mkdirSync('tokens', { recursive: true });
writeFileSync(join('tokens', 'live-runs.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const r of report.runs) console.log(`${r.runId} ${r.driver} ${r.servedBy.join(',')} ${r.turns} turns, input ${r.totalInputTokens} (mean ${r.meanInputTokensPerTurn}, peak ${r.peakInputTokens}), output ${r.totalOutputTokens} — ${r.outcome}`);
