import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Io } from '../core/cli.js';

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
