// Drop-in linter rule: no console.* inside route handlers (log through the app's logger, not stdout).
// Install: copy this file to plugins/rules/no-console-in-handlers/index.ts. Nothing else changes.
import { Node, SyntaxKind } from 'ts-morph';
import { allRoutes } from '../../../core/analysis.js';
import { defineRule, type RuleFailure } from '../../../core/sdk.js';

export default defineRule({
  id: 'no-console-in-handlers',
  description: 'Route handlers do not call console.*',
  unit: 'handlers',
  files: ['src/**/*.ts'],
  check(file, ctx) {
    const rel = ctx.rel(file);
    const routes = allRoutes(ctx.project, ctx.apiRoot).filter((r) => r.file === rel);
    const failures: RuleFailure[] = [];
    for (const route of routes) {
      for (const handler of route.handlers) {
        for (const call of handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const callee = call.getExpression();
          if (Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === 'console') {
            const { line, column } = file.getLineAndColumnAtPos(call.getStart());
            failures.push({ line, col: column, message: `console.${callee.getName()} in ${route.method.toUpperCase()} ${route.path}`, fix: 'remove it or use the app logger' });
          }
        }
      }
    }
    return { checked: routes.length, failures };
  },
});
