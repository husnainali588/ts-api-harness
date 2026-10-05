// Standard 04 — REST conventions: versioned base path, plural nouns, cursor pagination, idempotency keys on create,
// and consistent 201 (+ Location), 204, 404, 409 and 422.
import pluralize from 'pluralize';
import { Node, SyntaxKind } from 'ts-morph';
import { defineRule, type RuleFailure } from '../../../core/sdk.js';
import { allRoutes, getProp, isItemPath, schemaParsing, srcText, zodObjectKeys, type RouteSite } from '../../../core/analysis.js';

const fail = (route: RouteSite, message: string, fix: string): RuleFailure => ({ line: route.line, col: route.col, message, fix });
const handlerText = (route: RouteSite) => route.handlers.map((h) => h.getText()).join('\n');

function responseKeys(route: RouteSite): number[] {
  if (route.spec !== undefined) {
    const responses = getProp(route.spec, 'responses');
    return responses !== undefined && Node.isObjectLiteralExpression(responses) ? responses.getProperties().flatMap((p) => (Node.isPropertyNamed(p) ? [Number(p.getName())] : [])) : [];
  }
  return [...handlerText(route).matchAll(/\.status\((\d{3})\)/g)].map((m) => Number(m[1]));
}

/** Keys of the list query schema and of the 200 response schema. */
function listSchemas(route: RouteSite): { query: string[] | undefined; response: string[] | undefined } {
  if (route.spec !== undefined) {
    const responses = getProp(route.spec, 'responses');
    const ok = responses !== undefined && Node.isObjectLiteralExpression(responses) ? getProp(responses, '200') : undefined;
    return { query: zodObjectKeys(getProp(route.spec, 'query')), response: zodObjectKeys(ok) };
  }
  let query: string[] | undefined;
  let response: string[] | undefined;
  for (const fn of route.handlers) {
    for (const access of fn.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (access.getName() === 'query' && /^req/.test(access.getExpression().getText())) query ??= zodObjectKeys(schemaParsing(access));
    }
    for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'json') continue;
      const arg = call.getArguments()[0];
      if (arg !== undefined && Node.isCallExpression(arg)) {
        const parseCallee = arg.getExpression();
        if (Node.isPropertyAccessExpression(parseCallee)) response ??= zodObjectKeys(parseCallee.getExpression());
      }
    }
  }
  return { query, response };
}

export default defineRule({
  id: 'rest-conventions',
  description: 'Versioned base path, plural nouns, cursor pagination, idempotent create, 201/204/404/409/422',
  unit: 'routes',
  files: ['src/**/*.ts'],
  check(file, ctx) {
    const relPath = ctx.rel(file);
    const all = allRoutes(ctx.project, ctx.apiRoot);
    const routes = all.filter((r) => r.file === relPath);
    if (routes.length === 0) return { checked: 0, failures: [] };
    const src = srcText(ctx.project, ctx.apiRoot);
    const uniqueFields = (ctx.task?.fields ?? []).filter((f) => f.unique).map((f) => f.name);
    const failures: RuleFailure[] = [];
    for (const route of routes) {
      const segments = route.path.split('/').filter((s) => s !== '');
      const [version, ...rest] = segments;
      if (version === undefined || !/^v\d+$/.test(version)) failures.push(fail(route, `${route.path} is not under a versioned base path`, 'prefix it with /v1'));
      for (const seg of rest.filter((s) => !s.startsWith(':'))) {
        if (!/^[a-z][a-z0-9-]*$/.test(seg)) failures.push(fail(route, `segment "${seg}" is not lower-case kebab-case`, 'use lower-case plural nouns'));
        else if (!pluralize.isPlural(seg) || pluralize.singular(seg) === seg) failures.push(fail(route, `segment "${seg}" is not a plural noun`, `use /${pluralize.plural(seg)}`));
      }
      const statuses = responseKeys(route);
      const text = handlerText(route);
      const item = isItemPath(route.path);

      if (route.method === 'get' && !item) {
        const { query, response } = listSchemas(route);
        if (query === undefined || !query.includes('cursor') || !query.includes('limit')) failures.push(fail(route, `list ${route.path} does not take cursor + limit`, 'use query: ListQuery'));
        if (query !== undefined && (query.includes('page') || query.includes('offset'))) failures.push(fail(route, `list ${route.path} uses page/offset`, 'use cursor pagination'));
        if (response === undefined || !response.includes('data') || !response.includes('nextCursor')) failures.push(fail(route, `list ${route.path} does not return { data, nextCursor }`, 'respond with pageOf(Item)'));
      }
      if (route.method === 'post' && !item) {
        if (!statuses.includes(201)) failures.push(fail(route, `create ${route.path} does not answer 201`, 'respond 201'));
        if (!/location/i.test(text)) failures.push(fail(route, `create ${route.path} sets no Location`, 'return location: `/v1/…/${id}`'));
        if (!/idempotency-key/i.test(src)) failures.push(fail(route, `create ${route.path} has no Idempotency-Key support`, 'honour Idempotency-Key on POST'));
      }
      if (route.method === 'delete') {
        if (!statuses.includes(204) || statuses.some((s) => s >= 200 && s < 300 && s !== 204)) failures.push(fail(route, `delete ${route.path} does not answer 204`, 'respond 204 with no body'));
        if (/\.(json|send)\(\s*[^)\s]/.test(text)) failures.push(fail(route, `delete ${route.path} sends a body`, 'respond 204 with no body'));
      }
      if (item && route.method !== 'post' && !/NotFound|404/.test(text)) {
        failures.push(fail(route, `${route.method.toUpperCase()} ${route.path} has no 404 path for an unknown id`, 'throw new NotFound(...)'));
      }
      if (uniqueFields.length > 0 && (route.method === 'post' || route.method === 'put' || route.method === 'patch') && !/Conflict|409/.test(text)) {
        failures.push(fail(route, `${route.method.toUpperCase()} ${route.path} has no 409 for duplicate ${uniqueFields.join(', ')}`, 'throw new Conflict(...)'));
      }
    }
    if (!/422/.test(src) && routes[0] !== undefined) failures.push(fail(routes[0], 'validation failures are not answered with 422', 'map validation errors to 422'));
    return { checked: routes.length, failures };
  },
});
