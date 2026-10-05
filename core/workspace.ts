// Git worktree per run and safe path resolution (spec §5.8, §5.5 model workspace, §6 G1).
import { cpSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { exec } from './exec.js';
import type { Task } from './task.js';

export interface Workspace {
  readonly worktree: string; // absolute
  readonly branch: string;
  readonly apiRoot: string; // absolute; the model workspace
  readonly apiRel: string; // apiRoot relative to the worktree
}

export class PathError extends Error {}

export function taskSlug(task: Task): string {
  return basename(task.path, extname(task.path)).replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
}

export function apiRelFor(task: Task): string {
  return task.api !== undefined ? normalize(task.api).replace(/[\\/]+$/, '') : join('generated', `${task.resource}-api`);
}

async function git(args: string[], cwd: string): Promise<string> {
  const res = await exec('git', args, { cwd, timeoutMs: 120_000 });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/** Creates .harness/worktrees/<runId> on a fresh branch from HEAD; the user's working tree is never touched. */
export async function createWorkspace(opts: {
  repoRoot: string;
  task: Task;
  runId: string;
  driverId: string;
  templateDir?: string; // greenfield scaffold source
}): Promise<Workspace> {
  const short = opts.runId.slice(-6);
  const branch = `harness/${taskSlug(opts.task)}-${opts.driverId}-${short}`;
  const worktree = join(opts.repoRoot, '.harness', 'worktrees', opts.runId);
  mkdirSync(join(opts.repoRoot, '.harness', 'worktrees'), { recursive: true });
  await git(['worktree', 'add', '-b', branch, worktree, 'HEAD'], opts.repoRoot);
  const apiRel = apiRelFor(opts.task);
  const apiRoot = join(worktree, apiRel);
  if (opts.task.mode === 'brownfield') {
    if (!existsSync(apiRoot)) throw new Error(`brownfield api "${apiRel}" does not exist in the committed tree`);
  } else if (!existsSync(apiRoot)) {
    mkdirSync(apiRoot, { recursive: true });
    if (opts.templateDir !== undefined && existsSync(opts.templateDir)) {
      cpSync(opts.templateDir, apiRoot, { recursive: true, filter: (src) => !src.split(sep).includes('node_modules') });
    }
  }
  return { worktree, branch, apiRoot: realpathSync(apiRoot), apiRel };
}

export async function removeWorkspace(repoRoot: string, ws: Workspace, deleteBranch = false): Promise<void> {
  await git(['worktree', 'remove', '--force', ws.worktree], repoRoot);
  if (deleteBranch) await git(['branch', '-D', ws.branch], repoRoot);
}

function isDanglingSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() && !existsSync(path);
  } catch {
    return false;
  }
}

function deepestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = resolve(current, '..');
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Resolves a workspace-relative path to an absolute path inside `root`. Rejects absolute paths, ".." segments,
 * NUL bytes, and anything whose real path (following symlinks) lands outside the root.
 */
export function resolveInside(root: string, rel: string): string {
  if (rel.includes('\0')) throw new PathError('path contains a NUL byte');
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new PathError(`absolute paths are not allowed: ${rel}`);
  if (rel.split(/[\\/]+/).includes('..')) throw new PathError(`".." is not allowed: ${rel}`);
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, rel === '' ? '.' : rel);
  if (isDanglingSymlink(target)) throw new PathError(`path is a dangling symlink: ${rel}`);
  const existing = deepestExisting(target);
  const realExisting = realpathSync(existing);
  const realTarget = join(realExisting, relative(existing, target));
  const inside = relative(realRoot, realTarget);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new PathError(`path escapes the workspace: ${rel}`);
  return realTarget;
}

/** Workspace-relative POSIX path of an absolute path inside root. */
export function toRel(root: string, abs: string): string {
  return relative(realpathSync(root), abs).split(sep).join('/') || '.';
}
