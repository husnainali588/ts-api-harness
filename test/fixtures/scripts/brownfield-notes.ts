// A scripted brownfield session for tasks/orders-add-field.yaml: propose scope → extend tests (red) → change schemas
// and store (green) → finish. Used by test/brownfield.test.ts and for the free brownfield evidence run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Line = { text?: string; toolCalls: { name: string; input: unknown }[] };

export function brownfieldNotesScript(repoRoot: string): Line[] {
  const src = (rel: string) => readFileSync(join(repoRoot, 'fixtures/sample-api', rel), 'utf8');
  const replace = (text: string, from: string, to: string) => {
    if (!text.includes(from)) throw new Error(`fixture changed: "${from.slice(0, 40)}" not found`);
    return text.replace(from, to);
  };
  const call = (name: string, input: unknown = {}) => ({ name, input });

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
  const scope = ['src/orders/schemas.ts', 'src/orders/store.ts', 'test/orders/routes.test.ts', 'test/orders/store.test.ts'];

  return [
    { toolCalls: [call('get_task')] },
    { toolCalls: [call('propose_scope', { files: scope, reason: 'add optional notes to orders' })] },
    { toolCalls: [call('write_file', { path: 'test/orders/routes.test.ts', content: routesTest }), call('write_file', { path: 'test/orders/store.test.ts', content: storeTest })] },
    { toolCalls: [call('run_tests')] },
    { toolCalls: [call('write_file', { path: 'src/orders/schemas.ts', content: schemas }), call('write_file', { path: 'src/orders/store.ts', content: store })] },
    { toolCalls: [call('run_tests')] },
    { toolCalls: [call('finish', { summary: 'optional notes on orders' })] },
  ];
}
