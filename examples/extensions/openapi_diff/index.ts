// Drop-in tool: compares two OpenAPI JSON files and returns compact breaking-change lines.
// Install: copy this file to plugins/tools/openapi_diff/index.ts. Nothing else changes.
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

const Doc = z.looseObject({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function operations(doc: z.infer<typeof Doc>): Map<string, Record<string, unknown>> {
  const ops = new Map<string, Record<string, unknown>>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) if (METHODS.has(method) && isObject(op)) ops.set(`${method.toUpperCase()} ${path}`, op);
  }
  return ops;
}

const responseCodes = (op: Record<string, unknown>) => (isObject(op.responses) ? Object.keys(op.responses) : []);
const requiredParams = (op: Record<string, unknown>) =>
  (Array.isArray(op.parameters) ? op.parameters : []).flatMap((p) => (isObject(p) && p.required === true && typeof p.name === 'string' ? [`${String(p.in)}:${p.name}`] : []));

export function diffOpenApi(before: unknown, after: unknown): { breaking: string[]; additive: string[] } {
  const b = operations(Doc.parse(before));
  const a = operations(Doc.parse(after));
  const breaking: string[] = [];
  const additive: string[] = [];
  for (const [key, op] of b) {
    const next = a.get(key);
    if (next === undefined) {
      breaking.push(`removed ${key}`);
      continue;
    }
    for (const code of responseCodes(op)) if (!responseCodes(next).includes(code)) breaking.push(`${key}: response ${code} removed`);
    for (const param of requiredParams(next)) if (!requiredParams(op).includes(param)) breaking.push(`${key}: new required parameter ${param}`);
  }
  for (const key of a.keys()) if (!b.has(key)) additive.push(`added ${key}`);
  return { breaking, additive };
}

export default defineTool({
  name: 'openapi_diff',
  description: 'Compare two OpenAPI JSON files; list breaking changes.',
  fetch: true,
  input: z.object({ before: z.string(), after: z.string() }),
  run(input, ctx) {
    const load = (p: string): unknown => {
      const abs = ctx.resolvePath(p);
      if (!existsSync(abs)) throw new Error(`${p} not found`);
      return JSON.parse(readFileSync(abs, 'utf8'));
    };
    const { breaking, additive } = diffOpenApi(load(input.before), load(input.after));
    const raw = [...breaking.map((l) => `BREAKING ${l}`), ...additive.map((l) => `added    ${l}`)].join('\n');
    return {
      summary: `${breaking.length} breaking${breaking.length > 0 ? `: ${breaking.slice(0, 5).join('; ')}` : ''}; ${additive.length} additive`,
      ...(raw === '' ? {} : { raw }),
    };
  },
});
