// Drop-in ORM validator: every Prisma or Drizzle query on users selects explicit columns.
// Install: copy this file to plugins/rules/orm-explicit-columns/index.ts. Nothing else changes.
//   Prisma:  <client>.user(s).findMany/findFirst/findUnique(...) must pass { select: {...} }
//   Drizzle: db.select() with no column map .from(users) fails; db.query.users.findMany/findFirst must pass { columns }
import { Node, SyntaxKind, type CallExpression } from 'ts-morph';
import { defineRule, type RuleFailure } from '../../../core/sdk.js';

const PRISMA_READS = new Set(['findMany', 'findFirst', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow']);
const DRIZZLE_READS = new Set(['findMany', 'findFirst']);
const USERS = /^users?$/i;

function hasProp(arg: Node | undefined, name: string): boolean {
  return arg !== undefined && Node.isObjectLiteralExpression(arg) && arg.getProperty(name) !== undefined;
}

function at(node: Node, message: string, fix: string): RuleFailure {
  const { line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
  return { line, col: column, message, fix };
}

/** For `x.from(t)`, the call that `.from` hangs off (e.g. db.select()). */
function fromTarget(call: CallExpression): CallExpression | undefined {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'from') return undefined;
  const inner = callee.getExpression();
  return Node.isCallExpression(inner) ? inner : undefined;
}

export default defineRule({
  id: 'orm-explicit-columns',
  description: 'Prisma/Drizzle queries on users select explicit columns',
  unit: 'queries',
  files: ['src/**/*.ts'],
  check(file) {
    let checked = 0;
    const failures: RuleFailure[] = [];
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const method = callee.getName();
      const model = callee.getExpression();
      // Prisma: prisma.user.findMany(...)  and Drizzle relational: db.query.users.findMany(...)
      if (Node.isPropertyAccessExpression(model) && USERS.test(model.getName())) {
        const isDrizzle = Node.isPropertyAccessExpression(model.getExpression()) && model.getExpression().getText().endsWith('.query');
        if (isDrizzle && DRIZZLE_READS.has(method)) {
          checked += 1;
          if (!hasProp(call.getArguments()[0], 'columns')) failures.push(at(call, `${call.getText().split('(')[0]} without columns`, 'pass { columns: { … } }'));
        } else if (!isDrizzle && PRISMA_READS.has(method)) {
          checked += 1;
          if (!hasProp(call.getArguments()[0], 'select')) failures.push(at(call, `${call.getText().split('(')[0]} on users without select`, 'pass { select: { … } }'));
        }
        continue;
      }
      // Drizzle core: db.select().from(users) vs db.select({ id: users.id }).from(users)
      const select = fromTarget(call);
      const table = call.getArguments()[0];
      if (select !== undefined && table !== undefined && USERS.test(table.getText())) {
        const selectCallee = select.getExpression();
        if (Node.isPropertyAccessExpression(selectCallee) && selectCallee.getName() === 'select') {
          checked += 1;
          if (select.getArguments().length === 0) failures.push(at(select, 'select() with no column map from users', 'select({ id: users.id, … })'));
        }
      }
    }
    return { checked, failures };
  },
});
