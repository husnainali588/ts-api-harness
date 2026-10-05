// Standard 01 — Zod at every boundary: params, query, body and responses are parsed with Zod schemas;
// types come from z.infer, never written a second time.
import { Node, SyntaxKind } from 'ts-morph';
import { defineRule, type RuleFailure } from '../../../core/sdk.js';
import {
  allRoutes,
  declaredSchemas,
  firstParamName,
  getProp,
  insideParseArgs,
  isItemPath,
  isParseCall,
  loc,
  numberValue,
  pathParams,
  resolveValue,
  type RouteSite,
} from '../_shared/api.js';

const fail = (node: Node, message: string, fix: string): RuleFailure => ({ ...loc(node), message, fix });

/** Statuses a define-style handler returns: object literals with a numeric `status`. */
function returnedStatuses(fn: Node): { status: number; node: Node }[] {
  const objects: Node[] = [];
  if (Node.isArrowFunction(fn) && !Node.isBlock(fn.getBody())) objects.push(fn.getBody());
  for (const ret of fn.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
    const expr = ret.getExpression();
    if (expr !== undefined) objects.push(expr);
  }
  return objects.flatMap((o) => {
    const obj = Node.isParenthesizedExpression(o) ? o.getExpression() : o;
    if (!Node.isObjectLiteralExpression(obj)) return [];
    const status = numberValue(getProp(obj, 'status'));
    return status === undefined ? [] : [{ status, node: obj }];
  });
}

function checkDefine(route: RouteSite): RuleFailure[] {
  const spec = route.spec;
  if (spec === undefined) return [];
  const out: RuleFailure[] = [];
  const at = route.call;
  if (pathParams(route.path).length > 0 && getProp(spec, 'params') === undefined) {
    out.push(fail(at, `${route.method.toUpperCase()} ${route.path} has path params but no params schema`, 'add params: z.object({ … })'));
  }
  if (route.method === 'get' && !isItemPath(route.path) && getProp(spec, 'query') === undefined) {
    out.push(fail(at, `GET ${route.path} (list) has no query schema`, 'add query: ListQuery'));
  }
  if ((route.method === 'post' || route.method === 'put' || route.method === 'patch') && getProp(spec, 'body') === undefined) {
    out.push(fail(at, `${route.method.toUpperCase()} ${route.path} has no body schema`, 'add body: z.strictObject({ … })'));
  }
  const responses = getProp(spec, 'responses');
  const keys = responses !== undefined && Node.isObjectLiteralExpression(responses) ? responses.getProperties().flatMap((p) => (Node.isPropertyNamed(p) ? [Number(p.getName())] : [])) : [];
  if (keys.length === 0) out.push(fail(at, `${route.method.toUpperCase()} ${route.path} has no response schemas`, 'add responses: { 200: Schema }'));
  for (const fn of route.handlers) {
    for (const { status, node } of returnedStatuses(fn)) {
      if (!keys.includes(status)) out.push(fail(node, `returns ${status} without a response schema`, `add responses[${status}] or throw a problem error`));
    }
  }
  return out;
}

function checkExpress(route: RouteSite): RuleFailure[] {
  const out: RuleFailure[] = [];
  for (const fn of route.handlers) {
    const req = firstParamName(fn);
    const parsedSources = new Set<string>();
    for (const access of fn.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (req === undefined || access.getExpression().getText() !== req) continue;
      const source = access.getName();
      if (source !== 'body' && source !== 'query' && source !== 'params') continue;
      if (insideParseArgs(access)) parsedSources.add(source);
      else out.push(fail(access, `handler reads raw ${req}.${source}`, `parse it with a Zod schema first`));
    }
    const needs: string[] = [];
    if (pathParams(route.path).length > 0) needs.push('params');
    if (route.method === 'get' && !isItemPath(route.path)) needs.push('query');
    if (route.method === 'post' || route.method === 'put' || route.method === 'patch') needs.push('body');
    for (const need of needs) {
      if (!parsedSources.has(need)) out.push(fail(route.call, `${route.method.toUpperCase()} ${route.path} does not parse ${need} with a schema`, `parse req.${need} with a Zod schema`));
    }
    for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || (callee.getName() !== 'json' && callee.getName() !== 'send')) continue;
      const arg = call.getArguments()[0];
      if (arg === undefined) continue;
      const value = Node.isIdentifier(arg) ? resolveValue(arg) : arg;
      if (value !== undefined && Node.isCallExpression(value) && isParseCall(value)) continue;
      out.push(fail(call, `response body is not produced by a schema parse`, 'send Schema.parse(value)'));
    }
  }
  return out;
}

export default defineRule({
  id: 'zod-boundary',
  description: 'Params, query, body and responses parsed with Zod; types inferred, never duplicated; no z.any()',
  unit: 'handlers',
  files: ['src/**/*.ts'],
  check(file, ctx) {
    const relPath = ctx.rel(file);
    const routes = allRoutes(ctx.project, ctx.apiRoot).filter((r) => r.file === relPath);
    const failures: RuleFailure[] = [];
    for (const route of routes) failures.push(...(route.style === 'define' ? checkDefine(route) : checkExpress(route)));

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() === 'z.any') failures.push(fail(call, 'z.any() accepts anything', 'use a precise schema'));
    }
    const schemas = declaredSchemas(ctx.project, ctx.apiRoot).filter((s) => s.keys.length >= 2);
    const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k));
    const declared = [
      ...file.getInterfaces().map((i) => ({ node: i, name: i.getName(), keys: i.getProperties().map((p) => p.getName()) })),
      ...file.getTypeAliases().flatMap((t) => {
        const typeNode = t.getTypeNode();
        return typeNode !== undefined && Node.isTypeLiteral(typeNode)
          ? [{ node: t, name: t.getName(), keys: typeNode.getProperties().map((p) => p.getName()) }]
          : [];
      }),
    ];
    for (const d of declared) {
      const twin = schemas.find((s) => sameKeys(s.keys, d.keys));
      if (twin !== undefined) failures.push(fail(d.node, `type ${d.name} duplicates schema ${twin.name}`, `use z.infer<typeof ${twin.name}>`));
    }
    return { checked: routes.length, failures };
  },
});
