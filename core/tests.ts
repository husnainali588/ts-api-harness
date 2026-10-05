// Governed test runner + source↔test map (spec §6 G2). Only run_tests (through this module) writes observations.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import fg from 'fast-glob';
import { Project, SyntaxKind } from 'ts-morph';
import { z } from 'zod';
import { execTool } from './exec.js';
import type { TestCaseObservation, ToolOutput } from './sdk.js';
import { sha256, type RunState } from './state.js';

const posix = (p: string) => p.split('\\').join('/');

export const TEST_GLOBS = ['test/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'];
export const isTestFile = (rel: string) => /\.(test|spec)\.ts$/.test(rel);
export const isSourceFile = (rel: string) => /^src\/.+\.ts$/.test(rel) && !isTestFile(rel) && !rel.endsWith('.d.ts');

/** A test file that fails to load because what it imports does not exist (yet) is a genuine red. */
const IMPORT_FAILURE = /Cannot find module|Failed to (load|resolve)|does not provide an export named|Cannot find package/i;
export const LOAD_CASE = '(file failed to load)';

const Assertion = z.looseObject({
  fullName: z.string(),
  status: z.string(),
  failureMessages: z.array(z.string()).default([]),
});
const FileResult = z.looseObject({
  name: z.string(),
  status: z.string(),
  message: z.string().default(''),
  assertionResults: z.array(Assertion).default([]),
});
const Report = z.looseObject({ testResults: z.array(FileResult), success: z.boolean().optional() });

function caseStatus(status: string): TestCaseObservation['status'] {
  if (status === 'passed' || status === 'failed' || status === 'todo') return status;
  return 'skipped'; // skipped, pending, disabled
}

/** Counts toward observed red: an assertion failure, a thrown error, or an import that does not resolve yet. */
export function isRed(o: TestCaseObservation): boolean {
  return o.status === 'failed' && o.failureKind !== 'suite-error';
}

export function parseReport(json: unknown, apiRoot: string, turn: number): TestCaseObservation[] {
  const report = Report.parse(json);
  const out: TestCaseObservation[] = [];
  for (const file of report.testResults) {
    const rel = posix(relative(apiRoot, file.name));
    const abs = join(apiRoot, rel);
    const fileSha256 = existsSync(abs) ? sha256(readFileSync(abs)) : '';
    if (file.assertionResults.length === 0 && file.status === 'failed') {
      out.push({ file: rel, name: LOAD_CASE, status: 'failed', failureKind: IMPORT_FAILURE.test(file.message) ? 'load-error' : 'suite-error', fileSha256, turn });
      continue;
    }
    for (const a of file.assertionResults) {
      const status = caseStatus(a.status);
      const message = a.failureMessages.join('\n');
      out.push({
        file: rel,
        name: a.fullName,
        status,
        ...(status === 'failed' ? { failureKind: /AssertionError|expected/i.test(message) ? 'assertion' : 'error' } : {}),
        fileSha256,
        turn,
      });
    }
  }
  return out;
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 160);
}

/** Runs vitest in the API root with the JSON reporter and records per-test-case observations. */
export async function runTests(opts: { apiRoot: string; runDir: string; state: RunState; turn: number; saveRaw: (label: string, content: string) => string }): Promise<ToolOutput> {
  const vitest = join(opts.apiRoot, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) {
    opts.state.lastTest = 'UNPROVEN: vitest is not installed in the API';
    return { summary: 'UNPROVEN: vitest is not installed in the API (node_modules missing); tests cannot run.', isError: true };
  }
  mkdirSync(opts.runDir, { recursive: true });
  const outFile = join(opts.runDir, `vitest-${opts.turn}-${Date.now()}.json`);
  const res = await execTool(process.execPath, [vitest, 'run', '--reporter=json', `--outputFile=${outFile}`, '--passWithNoTests'], { cwd: opts.apiRoot, timeoutMs: 300_000 });
  if (!existsSync(outFile)) {
    opts.state.lastTest = 'UNPROVEN: the test runner crashed';
    return { summary: `UNPROVEN: the test runner produced no report (exit ${res.code}${res.timedOut ? ', timed out' : ''}).`, raw: `${res.stdout}\n${res.stderr}`, isError: true };
  }
  const rawJson = readFileSync(outFile, 'utf8');
  const cases = parseReport(JSON.parse(rawJson), opts.apiRoot, opts.turn);
  recordObservations(opts.state, cases, opts.runDir);

  const failed = cases.filter((c) => c.status === 'failed');
  const passed = cases.filter((c) => c.status === 'passed').length;
  const skipped = cases.filter((c) => c.status === 'skipped' || c.status === 'todo').length;
  const report = Report.parse(JSON.parse(rawJson));
  const messageFor = (c: TestCaseObservation): string => {
    const file = report.testResults.find((f) => posix(relative(opts.apiRoot, f.name)) === c.file);
    if (c.name === LOAD_CASE) return firstLine(file?.message ?? '');
    return firstLine(file?.assertionResults.find((a) => a.fullName === c.name)?.failureMessages.join('\n') ?? '');
  };
  const lines = failed.slice(0, 6).map((c) => `${c.file} › ${c.name}: ${messageFor(c)}`);
  const head = `PASS ${passed} / FAIL ${failed.length}${skipped > 0 ? ` / SKIP ${skipped}` : ''}`;
  const summary = failed.length === 0 ? `${head} — all green` : `${head} — ${lines.join(' | ')}${failed.length > 6 ? ` | … ${failed.length - 6} more` : ''}`;
  opts.state.lastTest = summary.slice(0, 300);
  const rawText = failed.map((c) => `${c.file} › ${c.name}\n${messageFor(c)}`).join('\n\n');
  return { summary, ...(failed.length > 0 ? { raw: `${rawText}\n\n--- vitest stderr ---\n${res.stderr}` } : {}) };
}

/** Latest observations replace earlier ones; every red case ever seen is kept for red→green continuity (G3). */
export function recordObservations(state: RunState, cases: TestCaseObservation[], runDir: string): void {
  state.observations = cases;
  for (const c of cases) {
    if (isRed(c) && !state.redCases.some((r) => r.file === c.file && r.name === c.name)) {
      state.redCases.push({ file: c.file, name: c.name, turn: c.turn, kind: c.failureKind ?? 'error' });
    }
  }
  writeFileSync(join(runDir, 'observations.json'), `${JSON.stringify({ latest: state.observations, red: state.redCases }, null, 2)}\n`);
}

// ── source ↔ test map ─────────────────────────────────────────────────────────────────────────────────

/** Candidate API-root-relative files an import specifier may refer to (works before the file exists). */
export function importCandidates(fromFile: string, specifier: string): string[] {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return [];
  const base = posix(normalize(join(dirname(fromFile), specifier)));
  if (base.startsWith('..')) return [];
  if (/\.(js|mjs|cjs)$/.test(base)) return [base.replace(/\.(js|mjs|cjs)$/, '.ts')];
  if (base.endsWith('.ts')) return [base];
  return [`${base}.ts`, `${base}/index.ts`];
}

export function conventionTest(source: string): string {
  return source.replace(/^src\//, 'test/').replace(/\.ts$/, '.test.ts');
}

/** Map of test file → source files it imports directly (resolved with ts-morph from import specifiers). */
export function buildImportMap(apiRoot: string): Map<string, string[]> {
  const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true, compilerOptions: { allowJs: false } });
  const map = new Map<string, string[]>();
  for (const rel of fg.sync(TEST_GLOBS, { cwd: apiRoot, onlyFiles: true, ignore: ['**/node_modules/**'] })) {
    const sf = project.addSourceFileAtPath(join(apiRoot, rel));
    const specifiers = [
      ...sf.getImportDeclarations().map((d) => d.getModuleSpecifierValue()),
      ...sf.getExportDeclarations().map((d) => d.getModuleSpecifierValue() ?? ''),
      ...sf
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .filter((c) => c.getExpression().getKind() === SyntaxKind.ImportKeyword)
        .map((c) => c.getArguments()[0]?.asKind(SyntaxKind.StringLiteral)?.getLiteralValue() ?? ''),
    ];
    map.set(posix(rel), specifiers.flatMap((s) => importCandidates(posix(rel), s)));
  }
  return map;
}

/** Test files mapped to a source file: tests that import it, plus the src/x/y.ts ↔ test/x/y.test.ts convention. */
export function mappedTests(apiRoot: string, source: string): string[] {
  const mapped = new Set<string>();
  for (const [test, imports] of buildImportMap(apiRoot)) if (imports.includes(source)) mapped.add(test);
  const conv = conventionTest(source);
  if (existsSync(join(apiRoot, conv))) mapped.add(conv);
  return [...mapped].sort();
}
