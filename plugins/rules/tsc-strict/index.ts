// Standard 03 (compiler half) — tsc --noEmit passes with strict and noUncheckedIndexedAccess. A missing flag is a fail.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { defineRule, type ProjectFileResult } from '../../../core/sdk.js';

const require = createRequire(import.meta.url);
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export default defineRule({
  id: 'tsc-strict',
  description: 'tsc --noEmit is clean with strict and noUncheckedIndexedAccess enabled',
  unit: 'errors',
  summary: 'count',
  files: ['tsconfig.json'],
  async checkProject(ctx) {
    const configPath = join(ctx.apiRoot, 'tsconfig.json');
    if (!existsSync(configPath)) {
      return { files: [{ file: 'tsconfig.json', checked: 1, failures: [{ line: 1, message: 'tsconfig.json is missing', fix: 'add a tsconfig.json with strict and noUncheckedIndexedAccess' }] }] };
    }
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    const options = parsed?.options ?? {};
    const configFailures = [];
    if (options.strict !== true) configFailures.push({ line: 1, message: 'compilerOptions.strict is not true', fix: 'set "strict": true' });
    if (options.noUncheckedIndexedAccess !== true) {
      configFailures.push({ line: 1, message: 'compilerOptions.noUncheckedIndexedAccess is not true', fix: 'set "noUncheckedIndexedAccess": true' });
    }

    const local = join(ctx.apiRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const tsc = existsSync(local) ? local : require.resolve('typescript/bin/tsc');
    const res = await ctx.exec(process.execPath, [tsc, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'], { timeoutMs: 300_000 });
    const byFile = new Map<string, ProjectFileResult>();
    for (const line of res.stdout.split('\n')) {
      const m = ERROR_LINE.exec(line.trim());
      if (m === null) continue;
      const [, file = '', ln = '1', col = '1', code = '', message = ''] = m;
      const entry = byFile.get(file) ?? { file, checked: 1, failures: [] };
      entry.failures.push({ line: Number(ln), col: Number(col), message: `${code} ${message}`.slice(0, 200) });
      byFile.set(file, entry);
    }
    if (res.code !== 0 && byFile.size === 0) {
      return { unproven: `tsc exited ${res.code} without parseable errors${res.timedOut ? ' (timed out)' : ''}` };
    }
    return { files: [{ file: 'tsconfig.json', checked: 1, failures: configFailures }, ...byFile.values()] };
  },
});
