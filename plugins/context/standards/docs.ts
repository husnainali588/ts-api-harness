// Standards documents served on demand by get_standard(id). Short, concrete, provider-neutral.

export const DOCS: Record<string, string> = {
  template: `# Template (greenfield APIs)
Files you must not edit: src/app.ts, src/http/*, src/routes/index.ts (generated), configs.
Write one route module per resource: src/routes/<resource>.ts, default-exporting an array of routes:

  import { randomUUID } from 'node:crypto';
  import { ListQuery } from '../http/pagination.js';
  import { Conflict, NotFound } from '../http/problem.js';
  import { NoContent, defineRoute, type AnyRoute } from '../http/route.js';
  import { MemoryStore } from '../http/store.js';
  export function thingsRoutes(store = new MemoryStore<Thing>()): AnyRoute[] {
    const create = defineRoute({ method: 'post', path: '/v1/things', body: CreateThing, responses: { 201: Thing },
      handler: ({ body }) => { const t = store.insert({ id: randomUUID(), ...body }); return { status: 201, body: t, location: \`/v1/things/\${t.id}\` }; } });
    ...
    return [create, list, get, update, remove];
  }
  export default thingsRoutes();

Schemas go in src/schemas/<thing>.ts (Zod; types via z.infer). Errors are thrown: NotFound, Conflict, ValidationProblem.
List: query: ListQuery, responses: { 200: pageOf(Thing) }, body: store.page(query.cursor, query.limit).
Delete: responses: { 204: NoContent }, return { status: 204 }.
MemoryStore<T>: insert, get, replace(id, item), delete, find(predicate), page(cursor, limit).
Tests: test/routes/<resource>.test.ts importing createApp from '../../src/app.js' and thingsRoutes from
'../../src/routes/<resource>.js' (createApp(thingsRoutes()) gives a fresh store per test); supertest for HTTP.`,

  tdd: `# Observed red (how writes are allowed)
A file under src/ can be written only after a mapped test failed under run_tests.
Mapped = a test that imports the file, or the same path under test/ with .test.ts.
Cycle: write test → run_tests (it must FAIL, e.g. "Cannot find module" or an assertion) → write source → run_tests (green).
Every test seen failing must end passing; never delete, rename or .skip a red test.`,

  'zod-boundary': `# zod-boundary
Every route parses params (if the path has :params), query (list GET), body (POST/PUT/PATCH) with Zod, and declares
responses[status] for every status it returns. defineRoute does the parsing: set params/query/body/responses.
Types come from z.infer<typeof Schema>; never hand-write an interface with the same fields. No z.any().`,

  'problem-json': `# problem-json (RFC 7807)
Every non-2xx is application/problem+json with type, title, status, detail, instance (= request path).
In route code: throw new NotFound(detail) / new Conflict(detail) / new ValidationProblem(title, detail).
Never res.status(4xx).json({ error }) and never return an error status from a handler.
The template already registers the 404 catch-all, malformed-JSON (400) and fallback (500, no stack) handlers.`,

  'tsc-strict': `# tsc-strict
tsc --noEmit must be clean with strict + noUncheckedIndexedAccess (configs are fixed).
Array index and Record lookups are possibly undefined: check before use.`,

  'no-unsafe-ts': `# no-unsafe-ts
No any (explicit or inferred), no non-null !, no @ts-ignore/@ts-nocheck/@ts-expect-error, no eslint-disable.
Values of unknown shape: give them type unknown and parse with a Zod schema.`,

  'rest-conventions': `# rest-conventions
Paths: /v1/<plural-noun>[/:id], lower-case. Create: POST /v1/things → 201 + location. List: GET /v1/things with
query ListQuery (cursor + limit, no page/offset) → { data, nextCursor } via pageOf(Thing). Get/update/delete on
/v1/things/:id → 404 (throw NotFound) for unknown ids. Update: PATCH with a partial strict body. Delete → 204, no body.
Unique fields (task) → 409 on create and update (throw Conflict). Validation → 422 (automatic). Idempotency-Key on
POST is handled by the template middleware.`,

  'tests-mapped': `# tests-mapped
Every source file has a mapped test (imports it, or test/<same path>.test.ts). No .skip, .only, .todo anywhere.`,

  'problem-probe': `# problem-probe
The harness boots the app and sends bad requests to every route: malformed JSON (400), empty body / missing field /
wrong type (422), malformed and unknown ids (404/422), unknown route and wrong method (404), limit=0, limit=10000,
garbage cursor (422), duplicate unique field (409), Idempotency-Key replay (identical) and reuse with another body (409).
Each error must be a correct problem+json. Using defineRoute + thrown problem errors satisfies it.`,

  'task-coverage': `# task-coverage
Greenfield: every behaviour verb in the task (create, list, get, update, delete) has its route under /v1/<resource>.
Brownfield: every task field appears in a request/response schema.`,
};
