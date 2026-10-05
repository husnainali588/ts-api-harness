// G3 bypass attempts (spec §6): finish is rejected with the failing lines unless everything is really green.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finishGate, continuity } from '../../core/finish.js';
import type { RunContext } from '../../core/loop.js';
import { loadRegistry } from '../../core/registry.js';
import { defineRule } from '../../core/sdk.js';
import { Evidence, RunState } from '../../core/state.js';
import { loadTask } from '../../core/task.js';
import { REPO_ROOT, apiCopy, call, makeRepo, readEvents, removeDir, scriptedRun, tempDir, type ScriptLine } from '../helpers.js';

const good = (rel: string) => readFileSync(join(REPO_ROOT, 'test/fixtures/good-api', rel), 'utf8');

let repo: string;
beforeAll(() => {
  repo = makeRepo('g3');
});
afterAll(() => removeDir(repo));

/** The honest greenfield sequence; `tamper` turns are inserted before finish. */
function honest(tamper: ScriptLine[] = [], source = good('src/routes/users.ts')): ScriptLine[] {
  return [
    { toolCalls: [call('write_file', { path: 'test/routes/users.test.ts', content: good('test/routes/users.test.ts') }), call('write_file', { path: 'test/schemas/user.test.ts', content: good('test/schemas/user.test.ts') })] },
    { toolCalls: [call('run_tests')] },
    { toolCalls: [call('write_file', { path: 'src/schemas/user.ts', content: good('src/schemas/user.ts') }), call('write_file', { path: 'src/routes/users.ts', content: source })] },
    { toolCalls: [call('run_tests')] },
    ...tamper,
    { toolCalls: [call('finish', { summary: 'done' })] },
  ];
}

function finishEvent(runId: string) {
  return readEvents(repo, runId).find((e) => e.type === 'finish-gate');
}

const HELLO_TEST = 'import { expect, it } from "vitest";\nimport { hello } from "../src/hello.js";\n\nit("says hi", () => {\n  expect(hello()).toBe("hi");\n});\n';

/** A red assertion recorded for test/hello.test.ts › says hi, then the source made green. */
const helloCycle: ScriptLine[] = [
  { toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: HELLO_TEST })] },
  { toolCalls: [call('run_tests')] },
  { toolCalls: [call('write_file', { path: 'src/hello.ts', content: 'export function hello(): string {\n  return "";\n}\n' })] },
  { toolCalls: [call('run_tests')] },
  { toolCalls: [call('edit_file', { path: 'src/hello.ts', oldString: 'return "";', newString: 'return "hi";' })] },
];

describe('G3 finish gate', () => {
  it('turns an honest run green', async () => {
    const summary = await scriptedRun(repo, honest());
    expect(summary.status).toBe('green');
    const gate = finishEvent(summary.runId);
    expect(gate?.green).toBe(true);
    expect(String(gate?.lines)).toMatch(/standards {4}pass {6}verdict 100%/);
  });

  it('rejects finish while a standards rule fails, with the failing lines', async () => {
    const summary = await scriptedRun(repo, honest([], `${good('src/routes/users.ts')}export const loose: any = 1;\n`), { maxTurns: 6 });
    expect(summary.status).not.toBe('green');
    const lines = String(finishEvent(summary.runId)?.lines);
    expect(lines).toMatch(/standards {4}FAIL/);
    expect(lines).toMatch(/no-unsafe-ts\s+FAIL\s+src\/routes\/users\.ts:\d+/);
  });

  it('rejects finish when a red test was later deleted or renamed', async () => {
    const renamed = 'import { expect, it } from "vitest";\n\nit("something else", () => {\n  expect(1).toBe(1);\n});\n';
    const summary = await scriptedRun(repo, honest([...helloCycle, { toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: renamed })] }]), { maxTurns: 12 });
    expect(summary.status).not.toBe('green');
    expect(String(finishEvent(summary.runId)?.lines)).toMatch(/test\/hello\.test\.ts › says hi: was red at turn \d+, now missing/);
  });

  it('rejects finish when a red test was later skipped', async () => {
    const skipped = HELLO_TEST.replace('it("says hi"', 'it.skip("says hi"');
    const summary = await scriptedRun(repo, honest([...helloCycle, { toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: skipped })] }]), { maxTurns: 12 });
    expect(summary.status).not.toBe('green');
    const lines = String(finishEvent(summary.runId)?.lines);
    expect(lines).toMatch(/says hi: was red at turn \d+, now skipped/);
    expect(lines).toMatch(/tests-mapped/);
  });

  it('rejects finish on the untouched scaffold (nothing of the task built)', async () => {
    const summary = await scriptedRun(repo, [{ toolCalls: [call('finish')] }], { maxTurns: 1 });
    expect(summary.status).not.toBe('green');
    expect(String(finishEvent(summary.runId)?.lines)).toMatch(/task-coverage\s+FAIL/);
  });

  it('rejects finish while any required rule is UNPROVEN', async () => {
    const api = apiCopy('test/fixtures/good-api', 'g3-unproven');
    const reports = tempDir('g3-reports');
    try {
      const full = await loadRegistry(REPO_ROOT);
      const unprovenRule = defineRule({ id: 'always-unproven', description: 'cannot run', unit: 'things', checkProject: () => ({ unproven: 'tool missing' }) });
      const registry = { ...full, rules: [...full.rules.filter((r) => r.def.id !== 'problem-probe'), { def: unprovenRule, source: 'test' }] };
      const run: RunContext = {
        runId: 'g3-unproven',
        task: loadTask('tasks/users.yaml', REPO_ROOT),
        registry,
        workspace: { worktree: api, branch: 'x', apiRoot: api, apiRel: '.' },
        state: new RunState(),
        evidence: new Evidence(reports, 'g3-unproven'),
        harnessRoot: REPO_ROOT,
        repoRoot: reports,
        turn: 1,
      };
      const gate = await finishGate(run);
      expect(gate.green).toBe(false);
      expect(gate.unproven).toContain('always-unproven: tool missing');
      expect(gate.lines.join('\n')).toMatch(/always-unproven\s+UNPROVEN/);
    } finally {
      removeDir(api);
      removeDir(reports);
    }
  });
});

describe('continuity', () => {
  const obs = (name: string, status: 'passed' | 'failed' | 'skipped', file = 't.test.ts') => ({ file, name, status, fileSha256: '', turn: 2 });
  it('accepts red cases that are green now and file-level load reds whose file now passes', () => {
    expect(continuity([{ file: 't.test.ts', name: 'a', turn: 1 }, { file: 't.test.ts', name: '(file failed to load)', turn: 1 }], [obs('a', 'passed')])).toEqual([]);
  });
  it('rejects missing, skipped and still-failing cases', () => {
    expect(continuity([{ file: 't.test.ts', name: 'a', turn: 1 }], [])).toHaveLength(1);
    expect(continuity([{ file: 't.test.ts', name: 'a', turn: 1 }], [obs('a', 'skipped')])[0]).toMatch(/now skipped/);
    expect(continuity([{ file: 't.test.ts', name: 'a', turn: 1 }], [obs('a', 'failed')])[0]).toMatch(/still failing/);
    expect(continuity([{ file: 'g.test.ts', name: '(file failed to load)', turn: 1 }], [])[0]).toMatch(/file is gone/);
  });
});
