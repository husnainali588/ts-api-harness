// G1 bypass attempts (spec §6): every one must be blocked with reason + fix, and nothing may be written.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, call, greenGate, makeRepo, readEvents, removeDir, scriptedRun } from '../helpers.js';

let repo: string;
beforeAll(() => {
  repo = makeRepo('g1', (dir) => {
    // A committed symlink inside the brownfield API that points outside it.
    mkdirSync(join(dir, 'outside'), { recursive: true });
    writeFileSync(join(dir, 'outside', 'secret.txt'), 'not for the model\n');
    symlinkSync('../../outside', join(dir, 'fixtures', 'sample-api', 'escape'));
  });
});
afterAll(() => removeDir(repo));

function resultsOf(runId: string) {
  return readEvents(repo, runId).filter((e) => e.type === 'hook' && e.hook === 'path-guard');
}

async function attempt(toolCall: { name: string; input: unknown }, taskPath = 'tasks/users.yaml') {
  const summary = await scriptedRun(repo, [{ toolCalls: [toolCall] }], { taskPath, maxTurns: 1, finishGate: greenGate });
  const decisions = resultsOf(summary.runId);
  return { summary, decisions, worktree: join(repo, summary.worktree) };
}

describe('G1 allows honest work inside the workspace', () => {
  it('writes a test file under the API root and logs exit 0', async () => {
    const { decisions, worktree } = await attempt(call('write_file', { path: 'test/users.test.ts', content: '// test\n' }));
    expect(decisions).toEqual([expect.objectContaining({ decision: 'pass', exit: 0 })]);
    expect(readFileSync(join(worktree, 'generated', 'users-api', 'test', 'users.test.ts'), 'utf8')).toBe('// test\n');
  });

  it('lets the model read harness-owned config it cannot write', async () => {
    const { decisions } = await attempt(call('read_file', { path: 'package.json' }), 'tasks/orders-add-field.yaml');
    expect(decisions[0]).toMatchObject({ decision: 'pass' });
  });
});

const BLOCKED: [string, { name: string; input: unknown }, string?][] = [
  ['path traversal write', call('write_file', { path: '../../core/loop.ts', content: 'x' })],
  ['traversal hidden mid-path', call('write_file', { path: 'src/../../../CLAUDE.md', content: 'x' })],
  ['absolute path write', call('write_file', { path: '/tmp/harness-g1-escape.ts', content: 'x' })],
  ['read outside the workspace', call('read_file', { path: '../../tasks/users.yaml' })],
  ['list outside the workspace', call('list_files', { dir: '..' })],
  ['write package.json', call('write_file', { path: 'package.json', content: '{}' })],
  ['edit package.json (case trick)', call('write_file', { path: 'Package.JSON', content: '{}' })],
  ['write tsconfig', call('write_file', { path: 'tsconfig.json', content: '{}' })],
  ['write tsconfig variant', call('write_file', { path: 'tsconfig.build.json', content: '{}' })],
  ['write vitest config', call('write_file', { path: 'vitest.config.ts', content: 'export default {}' })],
  ['write vitest config (mts)', call('write_file', { path: 'vitest.config.mts', content: 'export default {}' })],
  ['write eslint config', call('write_file', { path: 'eslint.config.js', content: 'export default []' })],
  ['write .eslintrc', call('write_file', { path: '.eslintrc.json', content: '{}' })],
  ['write into .harness', call('write_file', { path: '.harness/runs/x/observations.json', content: '[]' })],
  ['write into .git', call('write_file', { path: '.git/hooks/pre-commit', content: 'x' })],
  ['write into node_modules', call('write_file', { path: 'node_modules/vitest/index.js', content: 'x' })],
  ['read .env', call('read_file', { path: '.env' })],
  ['read .env.local', call('read_file', { path: 'config/.env.local' })],
  ['NUL byte', call('write_file', { path: 'src/a\u0000.ts', content: 'x' })],
  ['write through a symlink that leads out', call('write_file', { path: 'escape/evil.ts', content: 'x' }), 'tasks/orders-add-field.yaml'],
  ['read through a symlink that leads out', call('read_file', { path: 'escape/secret.txt' }), 'tasks/orders-add-field.yaml'],
];
// Brownfield scope (writes before propose_scope / outside the accepted scope) is the scope-guard hook: test/brownfield.test.ts.

describe('G1 blocks bypass attempts', () => {
  it.each(BLOCKED)('%s', async (_name, toolCall, taskPath) => {
    const { decisions } = await attempt(toolCall, taskPath ?? 'tasks/users.yaml');
    expect(decisions).toHaveLength(1);
    const [d] = decisions;
    expect(d).toMatchObject({ decision: 'block', exit: 2 });
    expect(typeof d?.reason).toBe('string');
    expect(typeof d?.fix).toBe('string');
    expect(String(d?.fix).length).toBeGreaterThan(10);
  });

  it('never wrote the escape targets', () => {
    expect(existsSync('/tmp/harness-g1-escape.ts')).toBe(false);
    expect(existsSync(join(repo, 'outside', 'evil.ts'))).toBe(false);
    expect(readFileSync(join(REPO_ROOT, 'core', 'loop.ts'), 'utf8')).not.toBe('x');
  });

  it('feeds the reason and the fix back to the model as an error result', async () => {
    const { summary } = await attempt(call('write_file', { path: 'package.json', content: '{}' }));
    const transcript = readFileSync(join(repo, 'runs', summary.runId, 'events.jsonl'), 'utf8');
    expect(transcript).toContain('harness-owned configuration');
  });

  it('search_code refuses globs with ".."', async () => {
    const summary = await scriptedRun(repo, [{ toolCalls: [call('search_code', { pattern: 'x', glob: '../**/*.ts' })] }], { maxTurns: 1 });
    const tool = readEvents(repo, summary.runId).find((e) => e.type === 'tool');
    expect(tool).toMatchObject({ isError: true });
  });
});

describe('budget on consecutive blocks', () => {
  it('stops the run as FAIL after N consecutive blocked calls', async () => {
    const bad = call('write_file', { path: 'package.json', content: '{}' });
    const summary = await scriptedRun(repo, [{ toolCalls: [bad, bad] }, { toolCalls: [bad, bad] }], { maxConsecutiveBlocks: 3, maxTurns: 5 });
    expect(summary.status).toBe('fail');
    expect(summary.reason).toMatch(/consecutive blocked calls/);
  });
});
