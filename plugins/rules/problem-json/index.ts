// Standard 02 — RFC 7807 errors, nothing else: every non-2xx response is application/problem+json with type, title,
// status, detail and instance; no ad-hoc { error } bodies; 404 catch-all, malformed-body and fallback handlers exist.
import { Node, SyntaxKind, type CallExpression, type ClassDeclaration, type SourceFile } from 'ts-morph';
import { defineRule, type RuleFailure, type RuleContext } from '../../../core/sdk.js';
import { declaredSchemas, functionLike, isParseCall, loc, numberValue, paramCount, stringValue } from '../../../core/analysis.js';

const PROBLEM_KEYS = ['type', 'title', 'status', 'detail', 'instance'];

/** Method names called on the result of `call`, following a fluent chain: res.status(4).type(..).json(..). */
function chainAfter(call: CallExpression): CallExpression[] {
  const out: CallExpression[] = [];
  let cur: Node = call;
  for (;;) {
    const access = cur.getParent();
    if (access === undefined || !Node.isPropertyAccessExpression(access) || access.getExpression() !== cur) break;
    const next = access.getParent();
    if (next === undefined || !Node.isCallExpression(next)) break;
    out.push(next);
    cur = next;
  }
  return out;
}

const methodName = (call: CallExpression) => {
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : undefined;
};

function isProblemBody(arg: Node | undefined): boolean {
  if (arg === undefined) return false;
  if (Node.isCallExpression(arg)) return isParseCall(arg) || /(^|\.)problem$/i.test(arg.getExpression().getText());
  return Node.isIdentifier(arg); // a value built elsewhere (e.g. a Problem parameter); checked dynamically by the probe
}

function extendsProblem(cls: ClassDeclaration | undefined, depth = 0): boolean {
  if (cls === undefined || depth > 6) return false;
  if (/Problem|HttpError/.test(cls.getName() ?? '')) return true;
  return extendsProblem(cls.getBaseClass(), depth + 1);
}

function appChecks(file: SourceFile, ctx: RuleContext): { paths: number; failures: RuleFailure[] } {
  const appCall = file.getDescendantsOfKind(SyntaxKind.CallExpression).find((c) => c.getExpression().getText() === 'express' && c.getArguments().length === 0);
  if (appCall === undefined) return { paths: 0, failures: [] };
  let notFound = false;
  let fallback = false;
  let malformed = false;
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (methodName(call) !== 'use') continue;
    for (const arg of call.getArguments()) {
      const fn = functionLike(arg);
      if (fn === undefined) continue;
      const n = paramCount(fn);
      if (n === 4) {
        fallback = true;
        if (/entity\.parse\.failed|SyntaxError/.test(fn.getText())) malformed = true;
      } else if (n === 2 || n === 3) {
        if (/404/.test(fn.getText())) notFound = true;
      }
    }
  }
  const failures: RuleFailure[] = [];
  const at = loc(appCall);
  if (!notFound) failures.push({ ...at, message: 'no catch-all 404 handler registered', fix: 'app.use(notFoundHandler) after the routes' });
  if (!malformed) failures.push({ ...at, message: 'malformed JSON bodies are not converted to problem+json', fix: "handle err.type === 'entity.parse.failed' in the error handler" });
  if (!fallback) failures.push({ ...at, message: 'no fallback error handler registered', fix: 'app.use(errorHandler) last' });
  const schemas = declaredSchemas(ctx.project, ctx.apiRoot);
  if (!schemas.some((s) => PROBLEM_KEYS.every((k) => s.keys.includes(k)))) {
    failures.push({ ...at, message: 'no Problem schema with type, title, status, detail and instance', fix: 'define Problem = z.object({ type, title, status, detail, instance })' });
  }
  return { paths: 3, failures };
}

export default defineRule({
  id: 'problem-json',
  description: 'Every non-2xx response is application/problem+json with type, title, status, detail, instance',
  unit: 'error paths',
  files: ['src/**/*.ts'],
  check(file, ctx) {
    const failures: RuleFailure[] = [];
    let paths = 0;
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const name = methodName(call);
      if (name === 'status') {
        const code = numberValue(call.getArguments()[0]);
        const chain = chainAfter(call);
        const setsProblemType = chain.some((c) => methodName(c) === 'type' && /problem\+json/.test(stringValue(c.getArguments()[0]) ?? ''));
        if (code === undefined && !setsProblemType) continue; // a dynamic success status (e.g. a validated reply)
        if (code !== undefined && code < 400) continue;
        paths += 1;
        const sender = chain.find((c) => methodName(c) === 'json' || methodName(c) === 'send');
        if (!setsProblemType) {
          failures.push({ ...loc(call), message: `${code ?? 'error'} response without application/problem+json`, fix: 'throw a problem error (NotFound, Conflict, …) or use sendProblem()' });
        } else if (sender !== undefined && !isProblemBody(sender.getArguments()[0])) {
          failures.push({ ...loc(sender), message: 'problem response body is not built with problem()', fix: 'send problem(req, status, slug, title, detail)' });
        }
      } else if (name === 'sendStatus') {
        const code = numberValue(call.getArguments()[0]);
        if (code !== undefined && code >= 400) {
          paths += 1;
          failures.push({ ...loc(call), message: `sendStatus(${code}) sends a plain-text error`, fix: 'throw a problem error instead' });
        }
      } else if (name === 'json' || name === 'send') {
        const arg = call.getArguments()[0];
        if (arg !== undefined && Node.isObjectLiteralExpression(arg)) {
          const keys = arg.getProperties().flatMap((p) => (Node.isPropertyNamed(p) || Node.isShorthandPropertyAssignment(p) ? [p.getName()] : []));
          if (keys.includes('error') || (keys.includes('message') && !keys.includes('type'))) {
            paths += 1;
            failures.push({ ...loc(arg), message: `ad-hoc { ${keys.join(', ')} } body`, fix: 'use problem() — type, title, status, detail, instance' });
          }
        }
      }
    }
    for (const thrown of file.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
      const expr = thrown.getExpression();
      if (!Node.isNewExpression(expr)) continue;
      const target = expr.getExpression();
      const decl = Node.isIdentifier(target) ? target.getSymbol()?.getAliasedSymbol()?.getDeclarations()[0] ?? target.getSymbol()?.getDeclarations()[0] : undefined;
      if (decl !== undefined && Node.isClassDeclaration(decl) && extendsProblem(decl)) paths += 1;
    }
    const app = appChecks(file, ctx);
    return { checked: paths + app.paths, failures: [...failures, ...app.failures] };
  },
});
