import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOAD_CASE, conventionTest, importCandidates, isRed, isSourceFile, mappedTests, parseReport } from '../core/tests.js';
import { removeDir, tempDir, writeFile } from './helpers.js';

describe('importCandidates', () => {
  it.each([
    ['test/a.test.ts', '../src/users.js', ['src/users.ts']],
    ['test/routes/a.test.ts', '../../src/routes/users.ts', ['src/routes/users.ts']],
    ['test/a.test.ts', '../src/lib', ['src/lib.ts', 'src/lib/index.ts']],
    ['test/a.test.ts', 'vitest', []],
    ['test/a.test.ts', '../../outside.js', []],
  ])('%s imports %s', (from, spec, expected) => {
    expect(importCandidates(from, spec)).toEqual(expected);
  });
});

describe('classification', () => {
  it('knows sources and convention tests', () => {
    expect(isSourceFile('src/routes/users.ts')).toBe(true);
    expect(isSourceFile('src/routes/users.test.ts')).toBe(false);
    expect(isSourceFile('test/users.test.ts')).toBe(false);
    expect(conventionTest('src/routes/users.ts')).toBe('test/routes/users.test.ts');
  });
});

describe('parseReport', () => {
  const root = '/api';
  const report = {
    testResults: [
      { name: '/api/test/a.test.ts', status: 'failed', message: "Cannot find module '../src/a.js'", assertionResults: [] },
      { name: '/api/test/b.test.ts', status: 'failed', message: 'SyntaxError: Unexpected token', assertionResults: [] },
      {
        name: '/api/test/c.test.ts',
        status: 'failed',
        message: '',
        assertionResults: [
          { fullName: 'c works', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2'] },
          { fullName: 'c skips', status: 'skipped', failureMessages: [] },
          { fullName: 'c passes', status: 'passed', failureMessages: [] },
        ],
      },
    ],
  };

  it('turns import failures into a red load case and syntax errors into a non-red suite error', () => {
    const cases = parseReport(report, root, 3);
    expect(cases.find((c) => c.file === 'test/a.test.ts')).toMatchObject({ name: LOAD_CASE, failureKind: 'load-error', turn: 3 });
    expect(cases.filter(isRed).map((c) => `${c.file} › ${c.name}`)).toEqual([`test/a.test.ts › ${LOAD_CASE}`, 'test/c.test.ts › c works']);
    expect(cases.find((c) => c.name === 'c skips')?.status).toBe('skipped');
  });
});

describe('mappedTests', () => {
  let root: string;
  beforeAll(() => {
    root = tempDir('map');
    writeFile(root, 'test/users.test.ts', 'import { createApp } from "../src/app.js";\nimport type { User } from "../src/schemas/user.js";\n');
    writeFile(root, 'test/routes/orders.test.ts', 'export {};\n');
    writeFile(root, 'test/dyn.test.ts', 'const m = await import("../src/lazy.js");\nexport * from "../src/reexport.js";\n');
  });
  afterAll(() => removeDir(root));

  it('maps by imports (also type-only, dynamic and re-exports) and by naming convention', () => {
    expect(mappedTests(root, 'src/app.ts')).toEqual(['test/users.test.ts']);
    expect(mappedTests(root, 'src/schemas/user.ts')).toEqual(['test/users.test.ts']);
    expect(mappedTests(root, 'src/routes/orders.ts')).toEqual(['test/routes/orders.test.ts']);
    expect(mappedTests(root, 'src/lazy.ts')).toEqual(['test/dyn.test.ts']);
    expect(mappedTests(root, 'src/reexport.ts')).toEqual(['test/dyn.test.ts']);
    expect(mappedTests(root, 'src/unmapped.ts')).toEqual([]);
  });
});
