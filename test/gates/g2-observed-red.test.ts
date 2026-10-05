// G2 bypass attempts (spec §6): a source write is refused until a mapped test was seen failing by run_tests.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOAD_CASE } from '../../core/tests.js';
import { call, makeRepo, readEvents, removeDir, scriptedRun } from '../helpers.js';

const SOURCE = 'export function hello(): string {\n  return "hi";\n}\n';
const TEST_IMPORTING = 'import { expect, it } from "vitest";\nimport { hello } from "../src/hello.js";\n\nit("says hi", () => {\n  expect(hello()).toBe("hi");\n});\n';
const TEST_TRIVIAL = 'import { expect, it } from "vitest";\n\nit("is trivially green", () => {\n  expect(1).toBe(1);\n});\n';
const TEST_BROKEN = 'import { it } from "vitest";\nit("broken", () => {\n';

let repo: string;
beforeAll(() => {
  repo = makeRepo('g2');
});
afterAll(() => removeDir(repo));

function decisions(runId: string) {
  return readEvents(repo, runId).filter((e) => e.type === 'hook' && e.hook === 'observed-red');
}

function apiFile(worktree: string, rel: string) {
  return join(repo, worktree, 'generated', 'users-api', rel);
}

describe('G2 blocks', () => {
  it('a source write before any test exists', async () => {
    const s = await scriptedRun(repo, [{ toolCalls: [call('write_file', { path: 'src/hello.ts', content: SOURCE })] }], { maxTurns: 1 });
    expect(decisions(s.runId)).toEqual([expect.objectContaining({ decision: 'block', exit: 2 })]);
    expect(String(decisions(s.runId)[0]?.reason)).toContain('no mapped test');
    expect(existsSync(apiFile(s.worktree, 'src/hello.ts'))).toBe(false);
  });

  it('a source write after a test was written but never run', async () => {
    const s = await scriptedRun(
      repo,
      [{ toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: TEST_IMPORTING })] }, { toolCalls: [call('write_file', { path: 'src/hello.ts', content: SOURCE })] }],
      { maxTurns: 2 },
    );
    expect(decisions(s.runId).at(-1)).toMatchObject({ decision: 'block' });
    expect(String(decisions(s.runId).at(-1)?.reason)).toContain('none recorded red');
  });

  it('a source write after the mapped test was seen green, never red', async () => {
    const s = await scriptedRun(
      repo,
      [
        { toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: TEST_TRIVIAL })] },
        { toolCalls: [call('run_tests')] },
        { toolCalls: [call('write_file', { path: 'src/hello.ts', content: SOURCE })] },
      ],
      { maxTurns: 3 },
    );
    expect(readEvents(repo, s.runId).find((e) => e.type === 'tool' && e.tool === 'run_tests')?.summary).toMatch(/^PASS 1 \/ FAIL 0/);
    expect(decisions(s.runId).at(-1)).toMatchObject({ decision: 'block' });
  });

  it('a test and a source written in the same turn', async () => {
    const s = await scriptedRun(
      repo,
      [{ toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: TEST_IMPORTING }), call('write_file', { path: 'src/hello.ts', content: SOURCE })] }],
      { maxTurns: 1 },
    );
    expect(decisions(s.runId)).toEqual([expect.objectContaining({ decision: 'block' })]);
    expect(existsSync(apiFile(s.worktree, 'src/hello.ts'))).toBe(false);
  });

  it('a "red" that is only a syntax error in the test itself', async () => {
    const s = await scriptedRun(
      repo,
      [
        { toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: TEST_BROKEN })] },
        { toolCalls: [call('run_tests')] },
        { toolCalls: [call('write_file', { path: 'src/hello.ts', content: SOURCE })] },
      ],
      { maxTurns: 3 },
    );
    expect(decisions(s.runId).at(-1)).toMatchObject({ decision: 'block' });
  });

  it('edit_file on a source file is gated the same way', async () => {
    const s = await scriptedRun(repo, [{ toolCalls: [call('edit_file', { path: 'src/app.ts', oldString: 'a', newString: 'b' })] }], { maxTurns: 1 });
    expect(decisions(s.runId)).toEqual([expect.objectContaining({ decision: 'block' })]);
  });
});

describe('G2 allows an honest TDD cycle', () => {
  it('test → run_tests (red) → source → run_tests (green)', async () => {
    const s = await scriptedRun(
      repo,
      [
        { toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: TEST_IMPORTING })] },
        { toolCalls: [call('run_tests')] },
        { toolCalls: [call('write_file', { path: 'src/hello.ts', content: SOURCE })] },
        { toolCalls: [call('run_tests')] },
      ],
      { maxTurns: 4 },
    );
    const tools = readEvents(repo, s.runId).filter((e) => e.type === 'tool' && e.tool === 'run_tests');
    expect(tools[0]?.summary).toMatch(/^PASS 0 \/ FAIL 1 — test\/hello\.test\.ts › \(file failed to load\): Cannot find module/);
    expect(tools[1]?.summary).toMatch(/^PASS 1 \/ FAIL 0 — all green/);
    expect(decisions(s.runId)).toEqual([expect.objectContaining({ decision: 'record', exit: 1 })]);
    expect(readFileSync(apiFile(s.worktree, 'src/hello.ts'), 'utf8')).toBe(SOURCE);
    const observations = JSON.parse(readFileSync(join(repo, '.harness', 'runs', s.runId, 'observations.json'), 'utf8'));
    expect(observations.red).toEqual([expect.objectContaining({ file: 'test/hello.test.ts', name: LOAD_CASE, kind: 'load-error' })]);
    expect(observations.latest).toEqual([expect.objectContaining({ file: 'test/hello.test.ts', name: 'says hi', status: 'passed' })]);
  });

  it('maps through an import even when the test name does not follow the convention', async () => {
    const test = 'import { expect, it } from "vitest";\nimport { twice } from "../src/lib/math.js";\n\nit("doubles", () => {\n  expect(twice(2)).toBe(4);\n});\n';
    const s = await scriptedRun(
      repo,
      [
        { toolCalls: [call('write_file', { path: 'test/arithmetic.test.ts', content: test })] },
        { toolCalls: [call('run_tests')] },
        { toolCalls: [call('write_file', { path: 'src/lib/math.ts', content: 'export const twice = (n: number): number => n * 2;\n' })] },
      ],
      { maxTurns: 3 },
    );
    expect(decisions(s.runId)).toEqual([expect.objectContaining({ decision: 'record' })]);
  });

  it('an assertion failure (source exists, behaviour missing) is red too', async () => {
    const stub = 'export function hello(): string {\n  return "";\n}\n';
    const s = await scriptedRun(
      repo,
      [
        { toolCalls: [call('write_file', { path: 'test/hello.test.ts', content: TEST_IMPORTING })] },
        { toolCalls: [call('run_tests')] },
        { toolCalls: [call('write_file', { path: 'src/hello.ts', content: stub })] },
        { toolCalls: [call('run_tests')] },
        { toolCalls: [call('edit_file', { path: 'src/hello.ts', oldString: 'return "";', newString: 'return "hi";' })] },
        { toolCalls: [call('run_tests')] },
      ],
      { maxTurns: 6 },
    );
    const runs = readEvents(repo, s.runId).filter((e) => e.type === 'tool' && e.tool === 'run_tests');
    expect(runs[1]?.summary).toMatch(/FAIL 1 — test\/hello\.test\.ts › says hi/);
    expect(runs[2]?.summary).toMatch(/all green/);
  });
});
