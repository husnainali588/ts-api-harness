// Template rule (standards check, linter rule or ORM validator). Copy to plugins/rules/<your-rule>/ (no leading "_").
// It joins `harness check` with its own pass/fail line per file and a file:line:col for every failure.
import { SyntaxKind } from 'ts-morph';
import { defineRule } from '../../../core/sdk.js';

export default defineRule({
  id: 'example-rule',
  description: 'No debugger statements in API source',
  unit: 'statements', // printed in the summary: "12/12 statements"
  files: ['src/**/*.ts'], // globs relative to the API root
  required: true, // counts toward the verdict
  check(file) {
    const statements = file.getDescendantsOfKind(SyntaxKind.DebuggerStatement);
    return {
      checked: statements.length, // 0 checked in every file → the rule prints n/a
      failures: statements.map((s) => ({
        line: s.getStartLineNumber(),
        col: s.getStart() - s.getStartLinePos() + 1,
        message: 'debugger statement',
        fix: 'remove it',
      })),
    };
  },
});
