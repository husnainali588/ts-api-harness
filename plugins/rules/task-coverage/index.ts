// The API actually does what the task asks: greenfield → the routes its behaviours name exist for the resource;
// brownfield → every task field appears in a request/response schema. n/a when no task is given.
import { defineRule, type RuleFailure } from '../../../core/sdk.js';
import { allRoutes, declaredSchemas, isItemPath, type Method } from '../_shared/api.js';

const VERBS: { pattern: RegExp; label: string; method: Method[]; item: boolean }[] = [
  { pattern: /\bcreat/i, label: 'create', method: ['post'], item: false },
  { pattern: /\blist/i, label: 'list', method: ['get'], item: false },
  { pattern: /\b(get|retriev|fetch|read|show)\b|\bget one\b/i, label: 'get by id', method: ['get'], item: true },
  { pattern: /\b(updat|edit|modif|patch|chang)/i, label: 'update', method: ['patch', 'put'], item: true },
  { pattern: /\b(delet|remov|destroy)/i, label: 'delete', method: ['delete'], item: true },
];

export default defineRule({
  id: 'task-coverage',
  description: 'Routes for every behaviour the task names (greenfield); every task field in a schema (brownfield)',
  unit: 'behaviours',
  files: ['src/**/*.ts'],
  checkProject(ctx) {
    const task = ctx.task;
    if (task === undefined) return { files: [] };
    const failures: RuleFailure[] = [];
    let checked = 0;
    if (task.mode === 'greenfield') {
      const routes = allRoutes(ctx.project, ctx.apiRoot).filter((r) => r.path.split('/').filter((s) => s !== '')[1] === task.resource);
      const text = task.behaviours.join('\n');
      for (const verb of VERBS) {
        if (!verb.pattern.test(text)) continue;
        checked += 1;
        if (!routes.some((r) => verb.method.includes(r.method) && isItemPath(r.path) === verb.item)) {
          const path = `/v1/${task.resource}${verb.item ? '/:id' : ''}`;
          failures.push({ line: 0, message: `task asks to ${verb.label} ${task.resource} but there is no ${verb.method.join('/').toUpperCase()} ${path}`, fix: 'add the route (test first)' });
        }
      }
      return { files: [{ file: `task ${task.path}`, checked, failures }] };
    }
    const keys = new Set(declaredSchemas(ctx.project, ctx.apiRoot).flatMap((s) => s.keys));
    for (const field of task.fields) {
      checked += 1;
      if (!keys.has(field.name)) failures.push({ line: 0, message: `task field "${field.name}" is in no request/response schema`, fix: `add ${field.name} to the ${task.resource} schemas (test first)` });
    }
    return { files: [{ file: `task ${task.path}`, checked, failures }] };
  },
});
