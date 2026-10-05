// G4 — ship gate against a temporary bare repo as "origin" (spec §6): refused on red, unproven, baseline, protected
// branches and staged secrets; on green it pushes only the feature branch.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ship, type PrCreator } from '../../core/ship.js';
import { call, greenGate, makeRepo, removeDir, scriptedRun, tempDir } from '../helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });

let repo: string;
let origin: string;
beforeAll(() => {
  repo = makeRepo('g4');
  origin = tempDir('g4-origin');
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'config', 'user.name', 'harness-test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
});
afterAll(() => {
  removeDir(repo);
  removeDir(origin);
});

const prs: { head: string; base: string; body: string }[] = [];
const fakePr: PrCreator = async ({ head, base, bodyFile }) => {
  prs.push({ head, base, body: readFileSync(bodyFile, 'utf8') });
  return { url: `https://example.invalid/pull/${prs.length}` };
};

const write = (path: string, content = '// ok\n') => ({ toolCalls: [call('write_file', { path, content })] });
const finish = { toolCalls: [call('finish')] };
const remoteBranches = () => git(origin, 'branch', '--format=%(refname:short)').split('\n').filter((b) => b !== '');

describe('G4 refuses', () => {
  it('a run that is not green', async () => {
    const red = async () => ({ green: false, lines: ['tests FAIL'], unproven: [] });
    const s = await scriptedRun(repo, [write('test/a.test.ts'), finish], { finishGate: red, maxTurns: 2 });
    expect(await ship({ repoRoot: repo, runId: s.runId, createPr: fakePr })).toMatchObject({ status: 'refused', reason: expect.stringMatching(/not green/) });
  });

  it('a green run that has anything unproven', async () => {
    const shaky = async () => ({ green: true, lines: ['standards pass'], unproven: ['problem-probe: could not boot'] });
    const s = await scriptedRun(repo, [write('test/a.test.ts'), finish], { finishGate: shaky });
    expect(await ship({ repoRoot: repo, runId: s.runId, createPr: fakePr })).toMatchObject({ status: 'refused', reason: expect.stringMatching(/unproven: problem-probe/) });
  });

  it('a baseline run', async () => {
    const s = await scriptedRun(repo, [write('test/a.test.ts'), finish], { finishGate: greenGate, baseline: true });
    expect(await ship({ repoRoot: repo, runId: s.runId, createPr: fakePr })).toMatchObject({ status: 'refused', reason: 'baseline runs never ship' });
  });

  it('a protected branch (main)', async () => {
    const s = await scriptedRun(repo, [write('test/a.test.ts'), finish], { finishGate: greenGate });
    const path = join(repo, 'runs', s.runId, 'summary.json');
    writeFileSync(path, readFileSync(path, 'utf8').replace(`"branch": "${s.branch}"`, '"branch": "main"'));
    expect(await ship({ repoRoot: repo, runId: s.runId, createPr: fakePr })).toMatchObject({ status: 'refused' });
  });

  it('a staged diff containing a key', async () => {
    const key = `sk-or-v1-${'a1b2c3d4'.repeat(8)}`;
    const s = await scriptedRun(repo, [write('test/leak.test.ts', `export const key = '${key}';\n`), finish], { finishGate: greenGate });
    const before = remoteBranches();
    const result = await ship({ repoRoot: repo, runId: s.runId, createPr: fakePr });
    expect(result).toMatchObject({ status: 'refused', reason: expect.stringMatching(/secret scan hit/) });
    expect(remoteBranches()).toEqual(before);
    expect(git(join(repo, s.worktree), 'diff', '--cached', '--name-only')).toBe('');
  });
});

describe('G4 ships a green run', () => {
  it('commits only the API and the evidence, pushes only the feature branch, opens a PR', async () => {
    const mainBefore = git(origin, 'rev-parse', 'main').trim();
    const s = await scriptedRun(repo, [write('test/hello.test.ts'), finish], { finishGate: greenGate });
    writeFileSync(join(repo, 'stray-file.txt'), 'must not ship\n');
    const result = await ship({ repoRoot: repo, runId: s.runId, createPr: fakePr });
    expect(result).toMatchObject({ status: 'shipped', branch: s.branch, prUrl: expect.stringMatching(/^https:/) });
    expect(remoteBranches()).toContain(s.branch);
    expect(git(origin, 'rev-parse', 'main').trim()).toBe(mainBefore);
    const files = git(origin, 'diff', '--name-only', 'main', s.branch).split('\n').filter((f) => f !== '');
    expect(files).toContain('generated/users-api/test/hello.test.ts');
    expect(files).toContain(`runs/${s.runId}/summary.json`);
    expect(files.every((f) => f.startsWith('generated/users-api/') || f.startsWith(`runs/${s.runId}/`) || f.startsWith(`reports/${s.runId}/`))).toBe(true);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    const pr = prs.at(-1);
    expect(pr).toMatchObject({ head: s.branch, base: 'main' });
    expect(pr?.body).toMatch(/### Honesty/);
    expect(JSON.parse(readFileSync(join(repo, 'runs', s.runId, 'summary.json'), 'utf8')).prUrl).toBe(result.prUrl);
  });

  it('reports UNPROVEN (no fallback) when the PR cannot be opened', async () => {
    const s = await scriptedRun(repo, [write('test/b.test.ts'), finish], { finishGate: greenGate });
    const result = await ship({ repoRoot: repo, runId: s.runId, createPr: async () => ({ unproven: 'gh is missing or not authenticated' }) });
    expect(result).toMatchObject({ status: 'unproven', reason: 'gh is missing or not authenticated' });
  });
});
