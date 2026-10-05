// Every source file has a mapped test (an importing test or test/x/y.test.ts); no .skip, .only or .todo anywhere.
import { defineRule, type RuleFailure } from '../../../core/sdk.js';
import { isSrcPath, isTestPath } from '../../../core/analysis.js';

const FOCUS_OR_SKIP = /\b(it|test|describe|suite|bench)\.(skip|only|todo|skipIf|runIf|fails)\b|\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(/;

export default defineRule({
  id: 'tests-mapped',
  description: 'Every source file has a mapped test; no .skip/.only/.todo',
  unit: 'files',
  files: ['src/**/*.ts', 'test/**/*.ts'],
  check(file, ctx) {
    const rel = ctx.rel(file);
    const failures: RuleFailure[] = [];
    if (isTestPath(rel)) {
      file
        .getFullText()
        .split('\n')
        .forEach((line, i) => {
          const m = FOCUS_OR_SKIP.exec(line);
          if (m !== null) failures.push({ line: i + 1, col: m.index + 1, message: `${m[0].replace(/\s*\($/, '')} changes what runs`, fix: 'remove it; every test must run' });
        });
      return { checked: 0, failures };
    }
    if (!isSrcPath(rel)) return { checked: 0, failures };
    if (ctx.mappedTests(rel).length === 0) {
      const conv = rel.replace(/^src\//, 'test/').replace(/\.ts$/, '.test.ts');
      failures.push({ line: 1, col: 1, message: `${rel} has no mapped test`, fix: `add ${conv} or a test that imports it` });
    }
    return { checked: 1, failures };
  },
});
