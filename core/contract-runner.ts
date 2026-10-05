// Contract snapshot runner: executed in a fresh Node process (tsx) so the API's current code is loaded. Writes the
// route table with the JSON Schema of every request and response schema (spec §8 brownfield step 2).
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RouteRefs, SchemaRef } from './analysis.js';

export type JsonSchema = Record<string, unknown>;

export interface ContractRoute {
  key: string; // "POST /v1/orders"
  params?: JsonSchema;
  query?: JsonSchema;
  body?: JsonSchema;
  responses: Record<string, JsonSchema | null>;
}

export interface Contract {
  source: 'routeTable' | 'ast';
  routes: ContractRoute[];
}

export interface ContractInput {
  apiRoot: string;
  astRoutes: RouteRefs[];
  outFile: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function snapshot(input: ContractInput): Promise<Contract | { error: string }> {
  const req = createRequire(join(input.apiRoot, 'package.json'));
  const zodMod: unknown = await import(pathToFileURL(req.resolve('zod')).href);
  const raw = isObject(zodMod) && isObject(zodMod.z) ? zodMod.z.toJSONSchema : isObject(zodMod) ? zodMod.toJSONSchema : undefined;
  if (typeof raw !== 'function') return { error: "cannot load the API's zod" };
  const toJson = (schema: unknown, io: 'input' | 'output'): JsonSchema | undefined => {
    if (schema === undefined || schema === null) return undefined;
    try {
      const out: unknown = Reflect.apply(raw, undefined, [schema, { io, unrepresentable: 'any' }]);
      if (!isObject(out)) return undefined;
      const { $schema: _s, ...rest } = out;
      return rest;
    } catch {
      return undefined;
    }
  };
  const load = async (ref: SchemaRef | undefined | null): Promise<unknown> => {
    if (ref === undefined || ref === null) return undefined;
    const mod: unknown = await import(pathToFileURL(join(input.apiRoot, ref.file)).href);
    return isObject(mod) ? mod[ref.name] : undefined;
  };

  const appMod: unknown = await import(pathToFileURL(join(input.apiRoot, 'src', 'app.ts')).href);
  const createApp = isObject(appMod) ? appMod.createApp : undefined;
  const app: unknown = typeof createApp === 'function' ? Reflect.apply(createApp, undefined, []) : undefined;
  const table: unknown = isObject(app) || typeof app === 'function' ? Reflect.get(app as object, 'routeTable') : undefined;

  const routes: ContractRoute[] = [];
  const put = (r: { key: string; params: JsonSchema | undefined; query: JsonSchema | undefined; body: JsonSchema | undefined; responses: Record<string, JsonSchema | null> }) =>
    routes.push({
      key: r.key,
      responses: r.responses,
      ...(r.params === undefined ? {} : { params: r.params }),
      ...(r.query === undefined ? {} : { query: r.query }),
      ...(r.body === undefined ? {} : { body: r.body }),
    });
  if (Array.isArray(table)) {
    for (const r of table.filter(isObject)) {
      const responses: Record<string, JsonSchema | null> = {};
      if (isObject(r.responses)) for (const [status, schema] of Object.entries(r.responses)) responses[status] = toJson(schema, 'output') ?? null;
      put({ key: `${String(r.method).toUpperCase()} ${String(r.path)}`, params: toJson(r.params, 'input'), query: toJson(r.query, 'input'), body: toJson(r.body, 'input'), responses });
    }
    return { source: 'routeTable', routes };
  }
  for (const r of input.astRoutes) {
    const responses: Record<string, JsonSchema | null> = {};
    for (const [status, ref] of Object.entries(r.responses)) responses[status] = toJson(await load(ref), 'output') ?? null;
    put({
      key: `${r.method.toUpperCase()} ${r.path}`,
      params: toJson(await load(r.params), 'input'),
      query: toJson(await load(r.query), 'input'),
      body: toJson(await load(r.body), 'input'),
      responses,
    });
  }
  return { source: 'ast', routes };
}

const inputPath = process.argv[2];
if (inputPath !== undefined && process.argv[1] !== undefined && process.argv[1].endsWith('contract-runner.ts')) {
  const input = JSON.parse(readFileSync(inputPath, 'utf8')) as ContractInput;
  let output: Contract | { error: string };
  try {
    output = await snapshot(input);
  } catch (error) {
    output = { error: `contract snapshot crashed: ${error instanceof Error ? error.message : String(error)}` };
  }
  writeFileSync(input.outFile, JSON.stringify(output));
  process.exit(0);
}
