// Regression from the first paid greenfield run: the model copied "[704 chars elided from history]" into a file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeRepo, readEvents, removeDir, scriptedRun } from './helpers.js';

let repo: string;
beforeAll(() => {
  repo = makeRepo('placeholder');
});
afterAll(() => removeDir(repo));

describe('placeholder-guard', () => {
  it.each([
    ['write_file', { path: 'test/x.test.ts', content: '[704 chars elided from history]' }],
    ['write_file', { path: 'test/y.test.ts', content: 'import x;\n[9387 chars elided from history]\n' }],
    ['edit_file', { path: 'test/z.test.ts', oldString: 'a', newString: '[write_file src/x.ts (3 lines) — content dropped from history]' }],
  ])('blocks %s with a history placeholder as content', async (tool, input) => {
    const s = await scriptedRun(repo, [{ toolCalls: [call(tool, input)] }], { maxTurns: 1 });
    const decision = readEvents(repo, s.runId).find((e) => e.hook === 'placeholder-guard');
    expect(decision).toMatchObject({ decision: 'block', exit: 2 });
    expect(String(decision?.fix)).toMatch(/full, real file content/);
  });

  it('passes real content', async () => {
    const s = await scriptedRun(repo, [{ toolCalls: [call('write_file', { path: 'test/ok.test.ts', content: '// real\n' })] }], { maxTurns: 1 });
    expect(readEvents(repo, s.runId).find((e) => e.hook === 'placeholder-guard')).toMatchObject({ decision: 'pass' });
  });
});
