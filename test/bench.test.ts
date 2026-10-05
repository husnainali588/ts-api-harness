// harness bench end to end with the scripted driver (offline estimate): baseline vs actual from ledgers only.
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bench, readLedger, tokenReport } from '../core/bench.js';
import { greenfieldUsersScript } from './fixtures/scripts/greenfield-users.js';
import { REPO_ROOT, makeRepo, removeDir, writeScript } from './helpers.js';

let repo: string;
let script: string;
beforeAll(() => {
  repo = makeRepo('bench');
  script = writeScript(repo, greenfieldUsersScript(REPO_ROOT), 'greenfield.jsonl');
});
afterAll(() => removeDir(repo));

describe('harness bench', () => {
  it('refuses the scripted driver unless --offline (never evidence)', async () => {
    await expect(bench({ harnessRoot: REPO_ROOT, repoRoot: repo, taskPath: 'tasks/users.yaml', driverId: 'scripted', script, env: {} })).rejects.toThrow(/refuses the local driver/);
  });

  it('writes tokens/<runId>.json from the two ledgers, with a capped baseline aligned on turns 1..N', async () => {
    const { path, report } = await bench({ harnessRoot: REPO_ROOT, repoRoot: repo, taskPath: 'tasks/users.yaml', driverId: 'scripted', script, env: {}, offline: true, baselineTurns: 8 });
    expect(existsSync(path)).toBe(true);
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(json).toMatchObject({ task: 'tasks/users.yaml', driver: 'scripted', targetPct: 90, evidence: false });
    expect(report.baseline).toMatchObject({ completed: false, stoppedBy: 'baseline turn cap (cost)' });
    expect(report.baseline.turns).toHaveLength(8);
    expect(report.perTurn).toHaveLength(8);
    expect(report.actual.completed).toBe(true);
    expect(report.note).toMatch(/aligned turns 1\.\.8/);
    expect(report.mechanisms.jitFetches).toBeGreaterThan(0);
    expect(report.mechanisms.bytesNotFrontLoaded).toBeGreaterThan(10_000);
    // Offline estimate of the reduction (the real number comes from provider usage in Phase 12).
    console.log(`offline estimate (baseline capped at 8): mean/turn ${report.reductionPct.meanPerTurn}% total ${report.reductionPct.total}% peak ${report.reductionPct.peak}%`, report.perTurn);
    expect(report.reductionPct.meanPerTurn).toBeGreaterThan(70);
    for (const t of report.perTurn) expect(t.actual).toBeLessThan(t.baseline);
  });

  it('full-run estimate (uncapped baseline) for the record', async () => {
    const { report } = await bench({ harnessRoot: REPO_ROOT, repoRoot: repo, taskPath: 'tasks/users.yaml', driverId: 'scripted', script, env: {}, offline: true });
    console.log(`offline estimate (full run, ${report.perTurn.length} turns): mean/turn ${report.reductionPct.meanPerTurn}% total ${report.reductionPct.total}% peak ${report.reductionPct.peak}%`);
    expect(report.baseline.completed).toBe(true);
    expect(report.reductionPct.total).toBeGreaterThan(70);
  });

  it('reuses an actual run only with the same task and driver', async () => {
    const { report } = await bench({ harnessRoot: REPO_ROOT, repoRoot: repo, taskPath: 'tasks/users.yaml', driverId: 'scripted', script, env: {}, offline: true, baselineTurns: 2 });
    const actualId = report.actual.runId;
    const reused = await bench({ harnessRoot: REPO_ROOT, repoRoot: repo, taskPath: 'tasks/users.yaml', driverId: 'scripted', script, env: {}, offline: true, baselineTurns: 2, actualRun: actualId });
    expect(reused.report.actual.runId).toBe(actualId);
    await expect(
      bench({ harnessRoot: REPO_ROOT, repoRoot: repo, taskPath: 'tasks/orders-add-field.yaml', driverId: 'scripted', script, env: {}, offline: true, baselineTurns: 2, actualRun: actualId }),
    ).rejects.toThrow(/different task/);
  });

  it('computes reductions from ledgers only', () => {
    const ledger = (runId: string, baseline: boolean, tokens: number[]) => ({
      runId, taskSha256: 'x', driver: 'd', baseline, completed: true, stoppedBy: '', transports: ['gateway'], servedBy: ['m'], mechanisms: {},
      turns: tokens.map((t, i) => ({ turn: i + 1, inputTokens: t, outputTokens: 1, source: 'provider' })),
    });
    const r = tokenReport('tasks/t.yaml', ledger('b', true, [10_000, 20_000]), ledger('a', false, [500, 1500, 900]), false);
    expect(r.reductionPct).toEqual({ meanPerTurn: 93.3, total: 93.3, peak: 92.5 });
    expect(r.perTurn).toEqual([{ turn: 1, baseline: 10_000, actual: 500, reductionPct: 95 }, { turn: 2, baseline: 20_000, actual: 1500, reductionPct: 92.5 }]);
    expect(r.evidence).toBe(true);
    expect(readLedger).toBeTypeOf('function');
  });
});
