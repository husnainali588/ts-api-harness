// Every test case asserts something (red-team fix): a test that only imports the source turns red while the
// module is missing and green as soon as it exists, which would unlock source writes without testing behaviour.
import { Node, SyntaxKind } from 'ts-morph';
import { defineRule, type RuleFailure } from '../../../core/sdk.js';

const TEST_CALL = /^(it|test)(\.(only|skip|concurrent|sequential|fails|each\(.*\)))?$/s;
const ASSERTION = /\b(expect|assert)\s*[.(]|\bexpect\.(assertions|hasAssertions)\b|\.rejects\b|\.resolves\b/;

export default defineRule({
  id: 'test-assertions',
  description: 'Every test case makes at least one assertion',
  unit: 'test cases',
  files: ['test/**/*.test.ts', 'test/**/*.spec.ts'],
  check(file) {
    let checked = 0;
    const failures: RuleFailure[] = [];
    // Local helpers that assert (function declarations or const arrow/function expressions in this file).
    const asserting = new Set<string>();
    for (const fn of file.getFunctions()) if (ASSERTION.test(fn.getBody()?.getText() ?? '')) asserting.add(fn.getName() ?? '');
    for (const v of file.getVariableDeclarations()) {
      const init = v.getInitializer();
      if (init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)) && ASSERTION.test(init.getBody().getText())) asserting.add(v.getName());
    }
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression().getText();
      if (!TEST_CALL.test(callee)) continue;
      const fn = call.getArguments()[1];
      if (fn === undefined || !(Node.isArrowFunction(fn) || Node.isFunctionExpression(fn))) continue;
      checked += 1;
      const body = fn.getBody().getText();
      // Calls to local helpers that assert (e.g. expectProblem(...)) count too.
      const helperAsserts = fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => asserting.has(c.getExpression().getText()));
      if (!ASSERTION.test(body) && !helperAsserts) {
        const title = call.getArguments()[0]?.getText() ?? '';
        const { line, column } = file.getLineAndColumnAtPos(call.getStart());
        failures.push({ line, col: column, message: `test ${title.slice(0, 50)} asserts nothing`, fix: 'add an expect(...) on the behaviour under test' });
      }
    }
    return { checked, failures };
  },
});
