// Brownfield flow with the scripted driver: scope, ratchet and contract gates, and one honest change ending green.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffContracts } from '../core/contract.js';
import type { Contract } from '../core/contract-runner.js';
import { REPO_ROOT, call, makeRepo, readEvents, removeDir, scriptedRun, type ScriptLine } from './helpers.js';

const TASK = 'tasks/orders-add-field.yaml';
const src = (rel: string) => readFileSync(join(REPO_ROOT, 'fixtures/sample-api', rel), 'utf8');
const replace = (text: string, from: string, to: string) => {
  if (!text.includes(from)) throw new Error(`fixture changed: "${from.slice(0, 40)}" not found`);
  return text.replace(from, to);
};

let repo: string;
beforeAll(() => {
  repo = makeRepo('brownfield');
});
afterAll(() => removeDir(repo));

const finishLines = (runId: string) => String(readEvents(repo, runId).find((e) => e.type === 'finish-gate')?.lines);

// ── the honest change: optional notes on orders ─────────────────────────────────────────────────────────
const routesTest = replace(
  src('test/orders/routes.test.ts'),
  "describe('GET /v1/orders', () => {",
  `describe('notes', () => {
  it('accepts optional notes on create and update and returns them', async () => {
    const created = await request(app).post('/v1/orders').send({ ...body, notes: 'leave at door' });
    expect(created.status).toBe(201);
    const order = Order.parse(created.body);
    expect(order.notes).toBe('leave at door');
    const updated = Order.parse((await request(app).patch(\`/v1/orders/\${order.id}\`).send({ notes: 'ring twice' })).body);
    expect(updated.notes).toBe('ring twice');
  });

  it('leaves notes out when not set', async () => {
    expect(await create()).not.toHaveProperty('notes');
  });
});

describe('GET /v1/orders', () => {`,
);
const storeTest = replace(
  src('test/orders/store.test.ts'),
  "  it('returns an empty page past the end', () => {",
  `  it('keeps notes when given', () => {
    expect(new OrderStore().create({ ...input, notes: 'n' }).notes).toBe('n');
  });

  it('returns an empty page past the end', () => {`,
);
let schemas = replace(src('src/orders/schemas.ts'), '  createdAt: z.iso.datetime(),\n});', '  createdAt: z.iso.datetime(),\n  notes: Notes.optional(),\n});');
schemas = replace(schemas, 'const AmountCents', 'const Notes = z.string().max(500);\nconst AmountCents');
schemas = replace(schemas, '  currency: Currency,\n});\nexport type CreateOrderBody', '  currency: Currency,\n  notes: Notes.optional(),\n});\nexport type CreateOrderBody');
schemas = replace(schemas, '    status: OrderStatus.optional(),\n  })', '    status: OrderStatus.optional(),\n    notes: Notes.optional(),\n  })');
const store = replace(src('src/orders/store.ts'), "      createdAt: new Date().toISOString(),\n    };", "      createdAt: new Date().toISOString(),\n      ...(input.notes === undefined ? {} : { notes: input.notes }),\n    };");

const SCOPE = ['src/orders/schemas.ts', 'src/orders/store.ts', 'test/orders/routes.test.ts', 'test/orders/store.test.ts'];

const honest: ScriptLine[] = [
  { toolCalls: [call('get_task')] },
  { toolCalls: [call('propose_scope', { files: SCOPE, reason: 'add optional notes to orders' })] },
  { toolCalls: [call('write_file', { path: 'test/orders/routes.test.ts', content: routesTest }), call('write_file', { path: 'test/orders/store.test.ts', content: storeTest })] },
  { toolCalls: [call('run_tests')] },
  { toolCalls: [call('write_file', { path: 'src/orders/schemas.ts', content: schemas }), call('write_file', { path: 'src/orders/store.ts', content: store })] },
  { toolCalls: [call('run_tests')] },
  { toolCalls: [call('finish', { summary: 'optional notes on orders' })] },
];

describe('brownfield', () => {
  it('applies the change honestly (scope → red → source → green) and ends green with an additive contract change', async () => {
    const summary = await scriptedRun(repo, honest, { taskPath: TASK });
    const lines = finishLines(summary.runId);
    expect(summary.status, lines).toBe('green');
    expect(lines).toMatch(/ratchet {6}pass/);
    expect(lines).toMatch(/contract {5}pass {6}no breaking change; additive: .*notes/);
    expect(readFileSync(join(repo, '.harness', 'runs', summary.runId, 'contract.before.json'), 'utf8')).toContain('POST /v1/orders');
    expect(readFileSync(join(repo, '.harness', 'runs', summary.runId, 'findings.before.json'), 'utf8').trim()).toBe('[]');
  });

  it('blocks writes before propose_scope and outside the accepted scope; rejects unreachable files', async () => {
    const summary = await scriptedRun(
      repo,
      [
        { toolCalls: [call('write_file', { path: 'test/orders/notes.test.ts', content: '// x\n' })] },
        { toolCalls: [call('propose_scope', { files: ['test/orders/store.test.ts', 'src/elsewhere/thing.ts'], reason: 'x' })] },
        { toolCalls: [call('write_file', { path: 'src/app.ts', content: '// x\n' })] },
      ],
      { taskPath: TASK, maxTurns: 3 },
    );
    const events = readEvents(repo, summary.runId);
    const blocks = events.filter((e) => e.hook === 'scope-guard').map((e) => String(e.reason));
    expect(blocks[0]).toMatch(/no scope accepted yet/);
    expect(blocks[1]).toMatch(/src\/app\.ts is outside the accepted scope/);
    expect(events.find((e) => e.type === 'scope')).toMatchObject({ accepted: ['test/orders/store.test.ts'], rejected: ['src/elsewhere/thing.ts'] });
  });

  it('blocks finish when a response field is removed (contract gate)', async () => {
    const schemaTest = replace(
      src('test/orders/schemas.test.ts'),
      "describe('Order and OrderIdParams', () => {",
      `describe('slim order', () => {
  it('no longer exposes createdAt', () => {
    expect(Order.shape).not.toHaveProperty('createdAt');
  });
});

describe('Order and OrderIdParams', () => {`,
    );
    const slim = replace(src('src/orders/schemas.ts'), '  createdAt: z.iso.datetime(),\n});', '});');
    const summary = await scriptedRun(
      repo,
      [
        { toolCalls: [call('propose_scope', { files: ['src/orders/schemas.ts', 'test/orders/schemas.test.ts'], reason: 'slim order' })] },
        { toolCalls: [call('write_file', { path: 'test/orders/schemas.test.ts', content: schemaTest })] },
        { toolCalls: [call('run_tests')] },
        { toolCalls: [call('write_file', { path: 'src/orders/schemas.ts', content: slim })] },
        { toolCalls: [call('finish')] },
      ],
      { taskPath: TASK, maxTurns: 5 },
    );
    expect(summary.status).not.toBe('green');
    expect(finishLines(summary.runId)).toMatch(/contract {5}FAIL .*\n?.*createdAt: field removed/);
  });

  it('blocks finish when a change creates a new finding in an untouched file (ratchet)', async () => {
    const schemaTest = replace(src('test/orders/schemas.test.ts'), "import { CreateOrderBody, Order, OrderIdParams, UpdateOrderBody }", "import { CreateOrderBody, Order, OrderIdParams, OrdersPage, UpdateOrderBody }");
    const renamed = replace(src('src/orders/schemas.ts'), 'export const OrderPage = ', 'export const OrdersPage = ');
    const summary = await scriptedRun(
      repo,
      [
        { toolCalls: [call('propose_scope', { files: ['src/orders/schemas.ts', 'test/orders/schemas.test.ts'], reason: 'rename' })] },
        { toolCalls: [call('write_file', { path: 'test/orders/schemas.test.ts', content: `${schemaTest}\ndescribe('page', () => { it('exists', () => { expect(OrdersPage).toBeDefined(); }); });\n` })] },
        { toolCalls: [call('run_tests')] },
        { toolCalls: [call('write_file', { path: 'src/orders/schemas.ts', content: renamed })] },
        { toolCalls: [call('finish')] },
      ],
      { taskPath: TASK, maxTurns: 5 },
    );
    expect(summary.status).not.toBe('green');
    expect(finishLines(summary.runId)).toMatch(/ratchet {6}FAIL[\s\S]*src\/orders\/routes\.ts/);
  });
});

describe('diffContracts', () => {
  const obj = (props: Record<string, unknown>, required: string[], extra: Record<string, unknown> = {}) => ({ type: 'object', properties: props, required, ...extra });
  const before: Contract = {
    source: 'ast',
    routes: [
      { key: 'POST /v1/x', body: obj({ a: { type: 'string', maxLength: 10 }, k: { type: 'string', enum: ['p', 'q'] } }, ['a'], { additionalProperties: false }), responses: { '201': obj({ id: { type: 'string' }, a: { type: 'string' } }, ['id', 'a']) } },
      { key: 'DELETE /v1/x/:id', responses: { '204': null } },
    ],
  };
  it('flags breaking changes and lists additive ones', () => {
    const after: Contract = {
      source: 'ast',
      routes: [
        { key: 'POST /v1/x', body: obj({ a: { type: 'string', maxLength: 5 }, k: { type: 'string', enum: ['p'] }, b: { type: 'number' }, c: { type: 'string' } }, ['a', 'b'], { additionalProperties: false }), responses: { '201': obj({ id: { type: 'string' }, z: { type: 'string' } }, ['id']) } },
        { key: 'GET /v1/x', responses: { '200': obj({}, []) } },
      ],
    };
    const d = diffContracts(before, after);
    expect(d.breaking).toEqual(
      expect.arrayContaining([
        'POST /v1/x body.a: maxLength narrowed to 5',
        'POST /v1/x body.k: enum value "q" removed',
        'POST /v1/x body.b: new required request field',
        'POST /v1/x 201.a: field removed',
        'DELETE /v1/x/:id: route removed',
      ]),
    );
    expect(d.additive).toEqual(expect.arrayContaining(['POST /v1/x body.c: new optional request field', 'POST /v1/x 201.z: new response field', 'GET /v1/x: new route']));
  });

  it('accepts an unchanged contract', () => {
    expect(diffContracts(before, before)).toEqual({ breaking: [], additive: [] });
  });
});
