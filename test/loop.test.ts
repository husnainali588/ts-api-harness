import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolSpecs } from '../core/loop.js';
import { loadRegistry } from '../core/registry.js';
import { REPO_ROOT, call, greenGate, makeRepo, readEvents, removeDir, scriptedRun } from './helpers.js';

let repo: string;
beforeAll(() => {
  repo = makeRepo('loop');
});
afterAll(() => removeDir(repo));

describe('runHarness with the scripted driver', () => {
  it('writes inside the worktree, logs exit statuses 0/1/2 and ends green only through the finish gate', async () => {
    const summary = await scriptedRun(
      repo,
      [
        { toolCalls: [call('write_file', { path: 'src/hello.ts', content: 'export const hello = 1;\n' })] },
        { toolCalls: [call('write_file', { path: '../escape.ts', content: 'x' })] },
        { toolCalls: [call('finish', { summary: 'done' })] },
      ],
      { finishGate: greenGate },
    );
    expect(summary.status).toBe('green');
    expect(summary.reason).toBe('finish gate green');
    const worktree = join(repo, summary.worktree);
    expect(readFileSync(join(worktree, 'generated', 'users-api', 'src', 'hello.ts'), 'utf8')).toContain('hello');
    expect(existsSync(join(worktree, 'generated', 'escape.ts'))).toBe(false);
    // The user's working tree is untouched.
    expect(existsSync(join(repo, 'generated'))).toBe(false);

    const exits = readEvents(repo, summary.runId)
      .filter((e) => e.type === 'hook')
      .map((e) => e.exit);
    expect(new Set(exits)).toEqual(new Set([0, 1, 2]));

    const runDir = join(repo, 'runs', summary.runId);
    for (const file of ['events.jsonl', 'summary.json', 'transcript.jsonl', 'tokens.json']) expect(existsSync(join(runDir, file))).toBe(true);
    expect(summary.fingerprint.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.branch).toMatch(/^harness\/users-scripted-/);
    expect(summary.honesty.unproven).toContain('token numbers are estimates (scripted/replayed driver), not evidence');
  });

  it('never ends green without a configured finish gate', async () => {
    const summary = await scriptedRun(repo, [{ toolCalls: [call('finish')] }], { maxTurns: 1 });
    expect(summary.status).toBe('unproven');
    expect(summary.gate?.green).toBe(false);
  });

  it('keeps going after a red finish gate and stops at the turn budget as UNPROVEN', async () => {
    const red = async () => ({ green: false, lines: ['tests  FAIL  1 failing'], unproven: [] });
    const summary = await scriptedRun(repo, [{ toolCalls: [call('finish')] }, { toolCalls: [call('get_task')] }], { finishGate: red, maxTurns: 2 });
    expect(summary.status).toBe('unproven');
    expect(summary.reason).toMatch(/turn budget exhausted/);
  });

  it('turns unknown tools and invalid input into error results', async () => {
    const summary = await scriptedRun(repo, [{ toolCalls: [call('rm_rf', {}), call('read_file', { nope: 1 })] }], { maxTurns: 1 });
    const tools = readEvents(repo, summary.runId).filter((e) => e.type === 'tool');
    expect(tools[0]).toMatchObject({ tool: 'rm_rf', error: 'unknown tool' });
    expect(String(tools[1]?.error)).toMatch(/invalid input: path/);
  });

  it('nudges once when the model answers without tools, then fails', async () => {
    const summary = await scriptedRun(repo, [{ text: 'I think I am done' }, { text: 'really done' }], { maxTurns: 5 });
    expect(summary.status).toBe('fail');
    expect(summary.reason).toBe('the model stopped without calling finish');
    expect(summary.turns).toBe(2);
  });

  it('stops at the token cap as UNPROVEN and still writes evidence', async () => {
    const summary = await scriptedRun(repo, [{ toolCalls: [call('get_task')] }, { toolCalls: [call('get_task')] }], { maxRunTokens: 10, maxTurns: 5 });
    expect(summary.status).toBe('unproven');
    expect(summary.reason).toMatch(/stopped by cost cap/);
    expect(existsSync(join(repo, 'runs', summary.runId, 'summary.json'))).toBe(true);
  });
});

describe('tool specs', () => {
  it('are neutral JSON Schema with valid names', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    const specs = toolSpecs(registry.tools.map((t) => t.def));
    expect(specs.map((s) => s.name)).toEqual(expect.arrayContaining(['list_files', 'read_file', 'search_code', 'write_file', 'edit_file', 'add_dependency', 'get_task', 'finish']));
    for (const spec of specs) {
      expect(spec.name).toMatch(/^[a-z0-9_]{1,64}$/);
      expect(spec.inputSchema.type).toBe('object');
      expect(spec.inputSchema).not.toHaveProperty('$schema');
    }
  });
});
