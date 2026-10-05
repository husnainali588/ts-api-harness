// Every standards rule: the reference API passes; a minimal bad mutation fails at the right file:line.
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChecks, type CheckReport } from '../core/checks.js';
import { loadRegistry, type Registry } from '../core/registry.js';
import { loadTask } from '../core/task.js';
import { REPO_ROOT, apiCopy, appendTo, mutate, removeDir, tempDir, writeFile } from './helpers.js';

let registry: Registry;
const dirs: string[] = [];
beforeAll(async () => {
  registry = await loadRegistry(REPO_ROOT);
});
afterAll(() => {
  for (const d of dirs) removeDir(d);
});

const task = loadTask('tasks/users.yaml', REPO_ROOT);

async function check(apiRoot: string, withTask = true): Promise<CheckReport> {
  const reports = tempDir('reports');
  dirs.push(reports);
  return runChecks({ apiRoot, registry, runId: 'test', reportsRoot: reports, ...(withTask ? { task } : {}) });
}

function copy(source = 'test/fixtures/good-api'): string {
  const dir = apiCopy(source, 'rules');
  dirs.push(dir);
  return dir;
}

function failuresOf(report: CheckReport, rule: string) {
  const outcome = report.rules.find((r) => r.id === rule);
  expect(outcome, `rule ${rule} ran`).toBeDefined();
  return (outcome?.files ?? []).flatMap((f) => f.failures.map((x) => ({ file: f.file, line: x.line, message: x.message })));
}

function expectFailAt(report: CheckReport, rule: string, file: string, line: number, message: RegExp) {
  expect(report.rules.find((r) => r.id === rule)?.status).toBe('fail');
  expect(failuresOf(report, rule)).toEqual(expect.arrayContaining([expect.objectContaining({ file, line, message: expect.stringMatching(message) })]));
  expect(report.green).toBe(false);
  expect(report.text).toMatch(new RegExp(`${rule}\\s+FAIL\\s+${file.replace(/[.]/g, '\\.')}:${line}`));
}

describe('reference APIs pass at 100%', () => {
  it('test/fixtures/good-api (template-based users API)', async () => {
    const report = await check(copy());
    expect(report.rules.map((r) => [r.id, r.status])).toEqual(expect.arrayContaining([['zod-boundary', 'pass'], ['rest-conventions', 'pass'], ['problem-json', 'pass']]));
    expect(report.verdictPct).toBe(100);
    expect(report.green).toBe(true);
    expect(report.text).toMatch(/verdict\s+100%\s+→ all rules pass/);
  });

  it('fixtures/sample-api (hand-written Express, no template)', async () => {
    const report = await check(copy('fixtures/sample-api'), false);
    expect(report.green).toBe(true);
    expect(report.rules.find((r) => r.id === 'zod-boundary')?.checked).toBe(5);
    expect(report.rules.find((r) => r.id === 'rest-conventions')?.checked).toBe(5);
  });

  it('the scaffolded template prints only pass or n/a and 100%', async () => {
    const report = await check(copy('templates/api'));
    expect(new Set(report.rules.map((r) => r.status))).toEqual(new Set(['pass', 'n/a']));
    expect(report.verdictPct).toBe(100);
    expect(report.green).toBe(true);
  });
});

describe('zod-boundary', () => {
  it('fails on missing schemas, z.any(), duplicated types and undeclared statuses', async () => {
    const api = copy();
    const create = mutate(api, 'src/routes/users.ts', "    body: CreateUserBody,\n", '');
    const getParams = mutate(api, 'src/routes/users.ts', "    params: UserIdParams,\n    responses: { 200: User },\n    handler: ({ params }) => {\n      const user", "    responses: { 200: User },\n    handler: ({ params }) => {\n      const user");
    const status = mutate(api, 'src/routes/users.ts', 'return { status: 200, body: user };', 'return { status: 202, body: user };');
    const anyLine = appendTo(api, 'src/schemas/user.ts', 'export const Loose = z.any();\n');
    const dupLine = appendTo(api, 'src/schemas/user.ts', 'export interface UserShape {\n  id: string;\n  email: string;\n  name: string;\n  createdAt: string;\n}\n');
    const report = await check(api);
    expectFailAt(report, 'zod-boundary', 'src/routes/users.ts', create - 3, /POST \/v1\/users has no body schema/);
    expectFailAt(report, 'zod-boundary', 'src/routes/users.ts', getParams - 3, /GET \/v1\/users\/:id has path params but no params schema/);
    expectFailAt(report, 'zod-boundary', 'src/routes/users.ts', status, /returns 202 without a response schema/);
    expectFailAt(report, 'zod-boundary', 'src/schemas/user.ts', anyLine, /z\.any\(\)/);
    expectFailAt(report, 'zod-boundary', 'src/schemas/user.ts', dupLine, /type UserShape duplicates schema User/);
  });

  it('fails on raw req.body reads in hand-written handlers', async () => {
    const api = copy('fixtures/sample-api');
    const line = mutate(api, 'src/orders/routes.ts', "const patch = parseInput(UpdateOrderBody, req.body, 'body');", 'const patch = UpdateOrderBody.parse({}); void req.body;');
    const report = await check(api, false);
    expectFailAt(report, 'zod-boundary', 'src/orders/routes.ts', line, /reads raw req\.body/);
  });
});

describe('problem-json', () => {
  it('fails on non-problem error responses and missing handlers', async () => {
    const api = copy();
    const oops = mutate(api, 'src/app.ts', '  app.use(notFoundHandler);\n', "  app.get('/v1/oops', (_req, res) => {\n    res.status(400).json({ error: 'bad' });\n  });\n");
    const report = await check(api);
    expectFailAt(report, 'problem-json', 'src/app.ts', oops + 1, /400 response without application\/problem\+json/);
    expectFailAt(report, 'problem-json', 'src/app.ts', oops + 1, /ad-hoc \{ error \} body/);
    expect(failuresOf(report, 'problem-json').map((f) => f.message)).toContain('no catch-all 404 handler registered');
  });

  it('fails without malformed-JSON handling or a complete Problem schema', async () => {
    const api = copy();
    mutate(api, 'src/http/problem.ts', "errorType(err) === 'entity.parse.failed'", "errorType(err) === 'other'");
    mutate(api, 'src/http/problem.ts', "  instance: z.string().startsWith('/'),\n", '');
    const report = await check(api);
    const messages = failuresOf(report, 'problem-json').map((f) => f.message);
    expect(messages).toContain('malformed JSON bodies are not converted to problem+json');
    expect(messages).toContain('no Problem schema with type, title, status, detail and instance');
  });
});

describe('tsc-strict', () => {
  it('fails when noUncheckedIndexedAccess is missing and on type errors', async () => {
    const api = copy();
    mutate(api, 'tsconfig.json', '    "noUncheckedIndexedAccess": true,\n', '');
    const broken = appendTo(api, 'src/routes/users.ts', "export const broken: number = 'x';\n");
    const report = await check(api);
    expectFailAt(report, 'tsc-strict', 'tsconfig.json', 1, /noUncheckedIndexedAccess is not true/);
    expectFailAt(report, 'tsc-strict', 'src/routes/users.ts', broken, /TS2322/);
    expect(report.text).toMatch(/tsc-strict\s+FAIL\s+2 errors/);
  });
});

describe('no-unsafe-ts', () => {
  it('fails on explicit any, non-null, ts-ignore and inferred any', async () => {
    const api = copy();
    const explicit = appendTo(api, 'src/schemas/user.ts', 'export const loose: any = 1;\n');
    const nonNull = appendTo(api, 'src/schemas/user.ts', 'export const first = [1].at(0)!;\n');
    const implicit = appendTo(api, 'src/schemas/user.ts', "export const parsed = JSON.parse('{}');\n");
    const ignore = appendTo(api, 'test/schemas/user.test.ts', '// @ts-ignore\nexport const n: number = 1;\n');
    const report = await check(api);
    expectFailAt(report, 'no-unsafe-ts', 'src/schemas/user.ts', explicit, /explicit any/);
    expectFailAt(report, 'no-unsafe-ts', 'src/schemas/user.ts', nonNull, /non-null assertion/);
    expectFailAt(report, 'no-unsafe-ts', 'src/schemas/user.ts', implicit, /expression typed any/);
    expectFailAt(report, 'no-unsafe-ts', 'test/schemas/user.test.ts', ignore, /@ts-ignore suppresses checking/);
  });
});

describe('rest-conventions', () => {
  it('fails on unversioned and singular paths', async () => {
    const api = copy();
    const listLine = mutate(api, 'src/routes/users.ts', "path: '/v1/users',\n    query", "path: '/users',\n    query");
    const report = await check(api);
    expectFailAt(report, 'rest-conventions', 'src/routes/users.ts', listLine - 2, /\/users is not under a versioned base path/);

    const api2 = copy();
    const all = mutate(api2, 'src/routes/users.ts', "path: '/v1/users',\n    body", "path: '/v1/user',\n    body");
    expectFailAt(await check(api2), 'rest-conventions', 'src/routes/users.ts', all - 2, /segment "user" is not a plural noun/);
  });

  it('fails on list without cursor, delete without 204, create without Location and missing 409', async () => {
    const api = copy();
    const list = mutate(api, 'src/routes/users.ts', 'query: ListQuery,', 'query: ListQuery.pick({ limit: true }),');
    const del = mutate(api, 'src/routes/users.ts', 'responses: { 204: NoContent },', 'responses: { 200: NoContent },');
    mutate(api, 'src/routes/users.ts', 'return { status: 204 };', 'return { status: 200 };');
    const create = mutate(api, 'src/routes/users.ts', ', location: `/v1/users/${user.id}` };', ' };');
    mutate(api, 'src/routes/users.ts', 'if (emailTaken(body.email)) throw new Conflict(`A user with email ${body.email} already exists.`);', '');
    const report = await check(api);
    expectFailAt(report, 'rest-conventions', 'src/routes/users.ts', list - 3, /does not take cursor \+ limit/);
    expectFailAt(report, 'rest-conventions', 'src/routes/users.ts', del - 4, /delete \/v1\/users\/:id does not answer 204/);
    expectFailAt(report, 'rest-conventions', 'src/routes/users.ts', create - 8, /create \/v1\/users sets no Location/);
    expectFailAt(report, 'rest-conventions', 'src/routes/users.ts', create - 8, /POST \/v1\/users has no 409 for duplicate email/);
  });
});

describe('tests-mapped', () => {
  it('fails on an unmapped source file and on .skip/.only', async () => {
    const api = copy();
    writeFile(api, 'src/extra.ts', 'export const extra = 1;\n');
    const skip = appendTo(api, 'test/schemas/user.test.ts', "describe.skip('later', () => {});\n");
    const only = appendTo(api, 'test/schemas/user.test.ts', "it.only('focus', () => {});\n");
    const report = await check(api);
    expectFailAt(report, 'tests-mapped', 'src/extra.ts', 1, /src\/extra\.ts has no mapped test/);
    expectFailAt(report, 'tests-mapped', 'test/schemas/user.test.ts', skip, /describe\.skip/);
    expectFailAt(report, 'tests-mapped', 'test/schemas/user.test.ts', only, /it\.only/);
  });
});

describe('harness check runner', () => {
  it('marks every rule UNPROVEN when dependencies cannot be installed', async () => {
    const dir = tempDir('noinstall');
    dirs.push(dir);
    cpSync(join(REPO_ROOT, 'test/fixtures/good-api/src'), join(dir, 'src'), { recursive: true });
    writeFile(dir, 'package.json', '{"name":"x","private":true}\n');
    const report = await check(dir);
    expect(report.rules.every((r) => r.status === 'unproven')).toBe(true);
    expect(report.green).toBe(false);
    expect(report.text).toMatch(/UNPROVEN\s+node_modules missing/);
  });

  it('writes standards.txt and standards.json', async () => {
    const report = await check(copy('templates/api'));
    expect(report.reportDir).toMatch(/reports\/test$/);
  });
});
