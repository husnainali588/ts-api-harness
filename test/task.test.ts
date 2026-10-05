import { describe, expect, it } from 'vitest';
import { TaskError, loadTask, normaliseTask, renderTaskBrief } from '../core/task.js';
import { REPO_ROOT, removeDir, tempDir, writeFile } from './helpers.js';

function fromYaml(text: string, path = 'tasks/t.yaml') {
  const dir = tempDir('task');
  try {
    writeFile(dir, path, text);
    return loadTask(path, dir);
  } finally {
    removeDir(dir);
  }
}

describe('provided task files', () => {
  it('loads tasks/users.yaml (greenfield)', () => {
    const task = loadTask('tasks/users.yaml', REPO_ROOT);
    expect(task.mode).toBe('greenfield');
    expect(task.resource).toBe('users');
    expect(task.singular).toBe('user');
    expect(task.fields.map((f) => f.name)).toEqual(['id', 'email', 'name', 'createdAt']);
    expect(task.fields.find((f) => f.name === 'email')).toMatchObject({ type: 'email', required: true, unique: true });
    expect(task.fields.find((f) => f.name === 'id')).toMatchObject({ generated: true, required: false });
    expect(task.fields.find((f) => f.name === 'name')?.constraints).toEqual({ minLength: 1, maxLength: 100 });
    expect(task.behaviours).toHaveLength(5);
    expect(task.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('loads tasks/orders-add-field.yaml (brownfield)', () => {
    const task = loadTask('tasks/orders-add-field.yaml', REPO_ROOT);
    expect(task.mode).toBe('brownfield');
    expect(task.api).toBe('fixtures/sample-api');
    expect(task.fields).toEqual([
      { name: 'notes', type: 'string', required: false, unique: false, generated: false, constraints: { maxLength: 500 } },
    ]);
  });
});

describe('tolerance for small format differences', () => {
  it('accepts JSON', () => {
    const task = fromYaml(JSON.stringify({ resource: 'users', fields: { email: 'email' }, behaviours: ['Create'] }), 'tasks/t.json');
    expect(task.fields[0]).toMatchObject({ name: 'email', type: 'email', required: true });
  });

  it('accepts the "behaviors" spelling, a field list and a singular resource', () => {
    const task = fromYaml(`resource: Product
fields:
  - { name: sku, type: string, unique: true }
  - { name: price, type: integer, optional: true, min: 0 }
behaviors:
  - List products.
`);
    expect(task.resource).toBe('products');
    expect(task.fields.map((f) => [f.name, f.required, f.unique])).toEqual([
      ['sku', true, true],
      ['price', false, false],
    ]);
    expect(task.behaviours).toEqual(['List products.']);
  });

  it('accepts everything nested under resource and keeps unknown keys', () => {
    const task = fromYaml(`resource:
  name: books
  fields:
    title: string
  behaviours:
    - action: create
      returns: 201
basePath: /v1
`);
    expect(task.resource).toBe('books');
    expect(task.fields[0]?.name).toBe('title');
    expect(task.behaviours[0]).toContain('action: create');
    expect(task.extra).toEqual({ basePath: '/v1' });
    expect(renderTaskBrief(task)).toContain('basePath: /v1');
  });

  it('treats a task with an api key as brownfield and requires api for mode: brownfield', () => {
    expect(fromYaml('resource: orders\napi: some/api\n').mode).toBe('brownfield');
    expect(() => fromYaml('resource: orders\nmode: brownfield\n')).toThrow(/needs an "api" key/);
  });

  it('reports unparseable and non-task files with the path', () => {
    expect(() => fromYaml('resource: [unclosed')).toThrow(TaskError);
    expect(() => fromYaml('just: a map\n')).toThrow(/tasks\/t\.yaml: not a task file/);
    expect(() => loadTask('tasks/missing.yaml', REPO_ROOT)).toThrow(/task file not found/);
  });
});

describe('renderTaskBrief', () => {
  it('is compact and provider-neutral', () => {
    const brief = renderTaskBrief(loadTask('tasks/users.yaml', REPO_ROOT));
    expect(brief).toContain('Task (greenfield): users');
    expect(brief).toContain('- email: email (required, unique)');
    expect(brief.length).toBeLessThan(1200);
  });

  it('normalises an in-memory document', () => {
    expect(normaliseTask('x.yaml', '', { resource: 'user', fields: { id: { type: 'uuid', generated: true } } }).fields[0]).toMatchObject({
      generated: true,
      required: false,
    });
  });
});
