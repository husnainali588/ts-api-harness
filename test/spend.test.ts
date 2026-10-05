// Spend is capped by code: per-run cap, total budget, refusal under 20k remaining, free models not counted,
// and recorded transcripts replay through the scripted driver.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHarness } from '../core/loop.js';
import { SpendLedger, effectiveCap, isPaidModel } from '../core/tokens.js';
import { call, harnessCopy, makeRepo, readEvents, removeDir, scriptedRun, writeFile } from './helpers.js';

const FAKE = `import type { Driver, TurnRequest, TurnResponse } from '../../core/driver.js';
import { defineDriver } from '../../core/sdk.js';
class Fake implements Driver {
  readonly id = 'fakepaid';
  constructor(readonly model: string) {}
  async turn(_req: TurnRequest): Promise<TurnResponse> {
    return { text: '', toolCalls: [{ id: 'c' + Math.random(), name: 'get_task', input: {} }], stop: 'tool_calls',
      usage: { inputTokens: 15000, outputTokens: 10, source: 'provider' }, transport: 'gateway', model: this.model };
  }
}
export default defineDriver({ id: 'fakepaid', description: 'fake paid driver', envKeys: [], envVars: ['FAKE_MODEL'],
  create: (opts) => new Fake(opts.env.FAKE_MODEL ?? 'vendor/paid-model') });
`;

let harness: string;
let repo: string;
beforeAll(() => {
  harness = harnessCopy('spend');
  writeFile(harness, 'drivers/fakepaid/index.ts', FAKE);
  repo = makeRepo('spend');
});
afterAll(() => {
  removeDir(harness);
  removeDir(repo);
});

const run = (spendFile: string, opts: { maxRunTokens?: number; totalBudget?: number; env?: Record<string, string>; maxTurns?: number }) =>
  runHarness({ harnessRoot: harness, repoRoot: repo, taskPath: 'tasks/users.yaml', driverId: 'fakepaid', spendFile, env: opts.env ?? {}, maxTurns: opts.maxTurns ?? 20, ...opts });

describe('cost caps', () => {
  it('helpers: free models are not paid; the cap is min(per-run, remaining)', () => {
    expect(isPaidModel(undefined)).toBe(false);
    expect(isPaidModel('google/gemma-4-31b-it:free')).toBe(false);
    expect(isPaidModel('anthropic/claude-haiku-4.5')).toBe(true);
    expect(effectiveCap(150_000, 650_000, 600_000)).toEqual({ cap: 50_000, remaining: 50_000 });
    expect(effectiveCap(150_000, undefined, 600_000)).toEqual({ cap: 150_000, remaining: undefined });
  });

  it('stops a paid run at its cap as UNPROVEN, records spend, still writes evidence', async () => {
    const spendFile = join(repo, '.harness', 'spend-a.json');
    const summary = await run(spendFile, { maxRunTokens: 40_000, totalBudget: 650_000 });
    expect(summary.status).toBe('unproven');
    expect(summary.reason).toMatch(/stopped by cost cap/);
    expect(summary.tokens.totalInputTokens).toBe(45_000);
    expect(new SpendLedger(spendFile).spent()).toBe(45_000);
    expect(summary.cost).toMatchObject({ paid: true, cap: 40_000, spentBefore: 0, spentAfter: 45_000 });
    expect(existsSync(join(repo, 'runs', summary.runId, 'summary.json'))).toBe(true);
  });

  it('uses the remaining total budget when it is smaller than the per-run cap', async () => {
    const spendFile = join(repo, '.harness', 'spend-b.json');
    writeFileSync(spendFile, JSON.stringify({ totalInputTokens: 600_000, runs: [] }));
    const summary = await run(spendFile, { maxRunTokens: 150_000, totalBudget: 650_000 });
    expect(summary.cost.cap).toBe(50_000);
    expect(summary.tokens.totalInputTokens).toBeLessThanOrEqual(60_000);
    expect(new SpendLedger(spendFile).spent()).toBe(600_000 + summary.tokens.totalInputTokens);
  });

  it('refuses to start a paid run with under 20,000 tokens left', async () => {
    const spendFile = join(repo, '.harness', 'spend-c.json');
    writeFileSync(spendFile, JSON.stringify({ totalInputTokens: 640_000, runs: [] }));
    await expect(run(spendFile, { maxRunTokens: 150_000, totalBudget: 650_000 })).rejects.toThrow(/refusing to start a paid run: 10000 input tokens left/);
  });

  it('does not count :free models', async () => {
    const spendFile = join(repo, '.harness', 'spend-d.json');
    const summary = await run(spendFile, { totalBudget: 650_000, env: { FAKE_MODEL: 'vendor/model:free' }, maxTurns: 2 });
    expect(summary.cost.paid).toBe(false);
    expect(new SpendLedger(spendFile).spent()).toBe(0);
  });
});

describe('transcript replay', () => {
  it('replays a recorded transcript through the scripted driver with the same tool calls', async () => {
    const first = await scriptedRun(repo, [{ toolCalls: [call('get_task')] }, { toolCalls: [call('list_files', { dir: '.' })] }], { maxTurns: 2 });
    const transcript = join(repo, 'runs', first.runId, 'transcript.jsonl');
    const replay = await runHarness({ harnessRoot: harness, repoRoot: repo, taskPath: 'tasks/users.yaml', driverId: 'scripted', script: transcript, env: {}, maxTurns: 2 });
    const tools = (runId: string) => readEvents(repo, runId).filter((e) => e.type === 'tool').map((e) => e.tool);
    expect(tools(replay.runId)).toEqual(tools(first.runId));
    expect(readFileSync(transcript, 'utf8').split('\n').filter((l) => l !== '')).toHaveLength(2);
  });
});
