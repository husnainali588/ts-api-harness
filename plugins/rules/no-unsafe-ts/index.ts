// Standard 03 (code half) — no any, no non-null assertions, no ts-ignore in generated code. Explicit escapes are
// checked in src/ and test/; expressions the type checker types as `any` are checked in src/.
import { Node, SyntaxKind, TypeFlags } from 'ts-morph';
import { defineRule, type RuleFailure } from '../../../core/sdk.js';
import { isSrcPath, loc } from '../_shared/api.js';

const DIRECTIVE = /(\/\/|\/\*)\s*(@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable)/;

const CHAIN_KINDS = new Set([SyntaxKind.CallExpression, SyntaxKind.PropertyAccessExpression, SyntaxKind.ElementAccessExpression, SyntaxKind.Identifier]);

/** True when `node` continues into a larger expression of the same chain (we report the chain's end only). */
function continuesChain(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) return false;
  if ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === node) return true;
  if (Node.isCallExpression(parent) && parent.getExpression() === node) return true;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return true;
  return false;
}

function isDeclarationName(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) return false;
  if ('getNameNode' in parent && typeof parent.getNameNode === 'function') {
    const name: unknown = parent.getNameNode();
    if (name === node) return true;
  }
  return Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent) || Node.isExportSpecifier(parent);
}

export default defineRule({
  id: 'no-unsafe-ts',
  description: 'No any (explicit or inferred), no non-null !, no @ts-ignore/@ts-nocheck/@ts-expect-error, no eslint-disable',
  unit: 'sites',
  summary: 'count',
  files: ['src/**/*.ts', 'test/**/*.ts'],
  check(file, ctx) {
    const failures: RuleFailure[] = [];
    for (const node of file.getDescendantsOfKind(SyntaxKind.AnyKeyword)) {
      failures.push({ ...loc(node), message: 'explicit any', fix: 'use a precise type or unknown + a schema' });
    }
    for (const node of file.getDescendantsOfKind(SyntaxKind.NonNullExpression)) {
      failures.push({ ...loc(node), message: `non-null assertion ${node.getText().slice(0, 40)}`, fix: 'check for undefined instead' });
    }
    file
      .getFullText()
      .split('\n')
      .forEach((line, i) => {
        const m = DIRECTIVE.exec(line);
        if (m !== null) failures.push({ line: i + 1, col: m.index + 1, message: `${m[2] ?? 'directive'} suppresses checking`, fix: 'fix the underlying error' });
      });

    if (isSrcPath(ctx.rel(file))) {
      const checker = ctx.checker.compilerObject;
      for (const node of file.getDescendants()) {
        if (!CHAIN_KINDS.has(node.getKind()) || continuesChain(node) || isDeclarationName(node)) continue;
        if (node.getFirstAncestor((a) => Node.isTypeNode(a)) !== undefined) continue;
        if (!node.getType().isAny()) continue;
        const contextual = checker.getContextualType(node.compilerNode as Parameters<typeof checker.getContextualType>[0]);
        if (contextual !== undefined && (contextual.flags & TypeFlags.Unknown) !== 0) continue;
        failures.push({ ...loc(node), message: `expression typed any: ${node.getText().slice(0, 50)}`, fix: 'parse it with a Zod schema or assign it to unknown first' });
      }
    }
    return { checked: 1, failures };
  },
});
