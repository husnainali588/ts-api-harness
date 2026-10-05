import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PathError, resolveInside, toRel } from '../core/workspace.js';
import { removeDir, tempDir } from './helpers.js';

let root: string;
let ws: string;
beforeAll(() => {
  root = tempDir('ws');
  ws = join(root, 'api');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'x.txt'), 'x');
  symlinkSync('../outside', join(ws, 'link-out'));
  symlinkSync('src', join(ws, 'link-in'));
  symlinkSync('../nowhere/file.ts', join(ws, 'dangling.ts'));
});
afterAll(() => removeDir(root));

describe('resolveInside', () => {
  it('resolves workspace-relative paths, existing or not', () => {
    expect(toRel(ws, resolveInside(ws, 'src/new/file.ts'))).toBe('src/new/file.ts');
    expect(toRel(ws, resolveInside(ws, './src'))).toBe('src');
    expect(toRel(ws, resolveInside(ws, 'link-in/a.ts'))).toBe('src/a.ts');
  });

  it.each([
    ['..', '".." is not allowed'],
    ['src/../../x', '".." is not allowed'],
    ['/etc/passwd', 'absolute paths are not allowed'],
    ['C:/x', 'absolute paths are not allowed'],
    ['link-out/x.txt', 'escapes the workspace'],
    ['link-out/new.ts', 'escapes the workspace'],
    ['dangling.ts', 'dangling symlink'],
    ['a\0b', 'NUL'],
  ])('rejects %s', (path, message) => {
    expect(() => resolveInside(ws, path)).toThrow(PathError);
    expect(() => resolveInside(ws, path)).toThrow(message);
  });
});
