import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Io } from '../core/cli.js';
import { runHarness, type RunOptions, type RunSummary } from '../core/loop.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Temp dirs live under .harness/tmp (gitignored) so node_modules resolution still reaches the repo's packages. */
export function tempDir(prefix: string): string {
  const base = join(REPO_ROOT, '.harness', 'tmp');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

/** A temp copy of the harness (core, plugins, drivers) that tests can drop plugins into. */
export function harnessCopy(prefix = 'copy'): string {
  const dir = tempDir(prefix);
  for (const part of ['core', 'plugins', 'drivers']) {
    cpSync(join(REPO_ROOT, part), join(dir, part), { recursive: true });
  }
  return dir;
}

export function writeFile(root: string, rel: string, content: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

function gitSync(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=harness-test', '-c', 'user.email=test@example.invalid', ...args], { cwd, stdio: 'pipe' });
}

/**
 * A throwaway git repo shaped like the harness repo's inputs: the task files and the sample API (without
 * node_modules), committed on main. Runs create their worktrees inside it.
 */
export function makeRepo(prefix = 'repo', extra: (dir: string) => void = () => {}): string {
  const dir = tempDir(prefix);
  cpSync(join(REPO_ROOT, 'tasks'), join(dir, 'tasks'), { recursive: true });
  cpSync(join(REPO_ROOT, 'fixtures', 'sample-api'), join(dir, 'fixtures', 'sample-api'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules'),
  });
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.harness/\n.env\n');
  extra(dir);
  gitSync(dir, ['init', '-q', '-b', 'main']);
  gitSync(dir, ['add', '-A']);
  gitSync(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

export type ScriptLine = { text?: string; toolCalls?: { name: string; input: unknown }[] };

export function writeScript(dir: string, turns: ScriptLine[], name = 'script.jsonl'): string {
  const path = join(dir, '.harness', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${turns.map((t) => JSON.stringify(t)).join('\n')}\n`);
  return path;
}

export const call = (name: string, input: unknown = {}) => ({ name, input });

let scriptCount = 0;

/** Runs the real loop with the scripted driver against a temp repo made by makeRepo(). */
export function scriptedRun(repo: string, turns: ScriptLine[], opts: Partial<RunOptions> = {}): Promise<RunSummary> {
  scriptCount += 1;
  const script = writeScript(repo, turns, `script-${scriptCount}.jsonl`);
  return runHarness({
    harnessRoot: REPO_ROOT,
    repoRoot: repo,
    taskPath: 'tasks/users.yaml',
    driverId: 'scripted',
    script,
    maxTurns: turns.length + 2,
    env: {},
    ...opts,
  });
}

export const greenGate = async () => ({ green: true, lines: ['test gate: green'], unproven: [] });

/** A temp copy of an API fixture with node_modules linked to the template's install. */
export function apiCopy(source: string, prefix = 'api'): string {
  const dir = tempDir(prefix);
  cpSync(join(REPO_ROOT, source), dir, { recursive: true, filter: (src) => !src.split('/').includes('node_modules') });
  symlinkSync(join(REPO_ROOT, 'templates', 'api', 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

/** Replaces `from` with `to` in a file (must match) and returns the 1-based line where `to` starts. */
export function mutate(root: string, rel: string, from: string, to: string): number {
  const path = join(root, rel);
  const text = readFileSync(path, 'utf8');
  const index = text.indexOf(from);
  if (index < 0) throw new Error(`mutate: "${from.slice(0, 40)}" not found in ${rel}`);
  writeFileSync(path, text.slice(0, index) + to + text.slice(index + from.length));
  return text.slice(0, index).split('\n').length;
}

export function appendTo(root: string, rel: string, text: string): number {
  const path = join(root, rel);
  const before = readFileSync(path, 'utf8');
  writeFileSync(path, `${before}${text}`);
  return before.split('\n').length;
}

export function readEvents(repo: string, runId: string): Record<string, unknown>[] {
  return readFileSync(join(repo, 'runs', runId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const parsed: unknown = JSON.parse(l);
      return typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
    });
}

export function captureIo(): Io & { lines: string[]; errors: string[]; text(): string } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    text: () => [...lines, ...errors].join('\n'),
  };
}
