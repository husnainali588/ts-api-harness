// problem-probe runner: executed in a fresh Node process (tsx) so the API's current code is loaded, never a cached
// copy. Boots createApp() on 127.0.0.1:0, sends schema-generated bad requests, writes the transcript as JSON.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface SchemaRef {
  file: string; // API-root-relative module
  name: string; // export name
}

export interface AstRoute {
  method: string;
  path: string;
  line: number;
  file: string;
  params?: SchemaRef;
  query?: SchemaRef;
  body?: SchemaRef;
}

export interface ProbeInput {
  apiRoot: string;
  astRoutes: AstRoute[];
  uniqueFields: string[];
  outFile: string;
}

export interface Probe {
  family: string;
  route: string; // "POST /v1/users" or "app"
  request: string;
  status: number;
  contentType: string;
  body: string;
  allowed: number[];
  problems: string[];
}

export interface ProbeOutput {
  error?: string;
  source?: 'routeTable' | 'ast';
  probes: Probe[];
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

interface ProbeRoute {
  method: string;
  path: string;
  params: unknown;
  query: unknown;
  body: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

// ── JSON-schema helpers ────────────────────────────────────────────────────────────────────────────────

type ToJsonSchema = (schema: unknown) => unknown;

function jsonSchemaOf(toJson: ToJsonSchema, schema: unknown): Record<string, unknown> | undefined {
  if (schema === undefined || schema === null) return undefined;
  try {
    const out = toJson(schema);
    return isObject(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

let counter = 0;
function sampleValue(schema: unknown, field: string): Json {
  counter += 1;
  if (!isObject(schema)) return 'x';
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const first: unknown = schema.enum[0];
    return typeof first === 'string' || typeof first === 'number' || typeof first === 'boolean' ? first : 'x';
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return sampleValue(schema.anyOf[0], field);
  const type = Array.isArray(schema.type) ? str(schema.type[0]) : str(schema.type);
  const format = str(schema.format);
  switch (type) {
    case 'string': {
      if (format === 'email') return `probe${counter}.${Date.now()}@example.com`;
      if (format === 'uuid') return randomUUID();
      if (format === 'date-time') return new Date().toISOString();
      if (format === 'uri') return `https://example.com/${counter}`;
      const min = typeof schema.minLength === 'number' ? schema.minLength : 1;
      const max = typeof schema.maxLength === 'number' ? schema.maxLength : 40;
      const base = `${field}-${counter}`;
      return (base.length < min ? base.padEnd(min, 'x') : base).slice(0, Math.max(min, Math.min(max, base.length)));
    }
    case 'integer':
    case 'number': {
      const min = typeof schema.minimum === 'number' ? schema.minimum : typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + 1 : 1;
      return Math.max(min, 1);
    }
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return sampleObject(schema);
    default:
      return 'x';
  }
}

function sampleObject(schema: Record<string, unknown>): JsonObject {
  const props = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [];
  const out: JsonObject = {};
  for (const key of required) out[key] = sampleValue(props[key], key);
  return out;
}

function wrongValue(schema: unknown): Json {
  const type = isObject(schema) ? (Array.isArray(schema.type) ? str(schema.type[0]) : str(schema.type)) : '';
  if (type === 'string') return 12345;
  if (type === 'integer' || type === 'number') return 'not-a-number';
  if (type === 'boolean') return 'not-a-boolean';
  if (type === 'array') return 'not-an-array';
  return ['wrong'];
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────────────

interface Sent {
  status: number;
  contentType: string;
  text: string;
  path: string;
}

async function send(base: string, method: string, path: string, opts: { body?: string; json?: Json; headers?: Record<string, string> } = {}): Promise<Sent> {
  const headers: Record<string, string> = { ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] = 'application/json';
  } else if (opts.body !== undefined) {
    body = opts.body;
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, { method: method.toUpperCase(), headers, ...(body === undefined ? {} : { body }) });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', text: await res.text(), path: new URL(`${base}${path}`).pathname };
}

const STACK = /\n\s+at\s|\(\/[^)]*\.(ts|js):\d+:\d+\)|node_modules\//;

function judge(sent: Sent, allowed: number[]): string[] {
  const problems: string[] = [];
  if (!allowed.includes(sent.status)) problems.push(`status ${sent.status} not in allowed {${allowed.join(', ')}}`);
  if (sent.status < 400) return problems;
  if (!/^application\/problem\+json\b/.test(sent.contentType)) problems.push(`media type ${sent.contentType || '(none)'} is not application/problem+json`);
  let body: unknown;
  try {
    body = JSON.parse(sent.text);
  } catch {
    problems.push('body is not JSON');
    return problems;
  }
  if (!isObject(body)) {
    problems.push('body is not a JSON object');
    return problems;
  }
  for (const key of ['type', 'title', 'detail', 'instance']) {
    if (typeof body[key] !== 'string') problems.push(`problem.${key} missing or not a string`);
  }
  if (typeof body.status !== 'number') problems.push('problem.status missing or not a number');
  else if (body.status !== sent.status) problems.push(`problem.status ${body.status} ≠ HTTP ${sent.status}`);
  if (typeof body.instance === 'string' && body.instance !== sent.path) problems.push(`problem.instance "${body.instance}" ≠ path "${sent.path}"`);
  if (STACK.test(sent.text)) problems.push('response leaks a stack trace');
  return problems;
}

// ── probing ───────────────────────────────────────────────────────────────────────────────────────────

async function loadExport(apiRoot: string, ref: SchemaRef | undefined): Promise<unknown> {
  if (ref === undefined) return undefined;
  const mod: unknown = await import(pathToFileURL(join(apiRoot, ref.file)).href);
  return isObject(mod) ? mod[ref.name] : undefined;
}

export async function probeApi(input: ProbeInput): Promise<ProbeOutput> {
  const requireFromApi = createRequire(join(input.apiRoot, 'package.json'));
  const zodMod: unknown = await import(pathToFileURL(requireFromApi.resolve('zod')).href);
  const toJsonRaw = isObject(zodMod) && isObject(zodMod.z) ? zodMod.z.toJSONSchema : isObject(zodMod) ? zodMod.toJSONSchema : undefined;
  if (typeof toJsonRaw !== 'function') return { error: 'cannot load the API\'s zod (toJSONSchema)', probes: [] };
  const toJson: ToJsonSchema = (schema) => {
    const result: unknown = Reflect.apply(toJsonRaw, undefined, [schema, { io: 'input', unrepresentable: 'any' }]);
    return result;
  };

  const appMod: unknown = await import(pathToFileURL(join(input.apiRoot, 'src', 'app.ts')).href);
  const createApp = isObject(appMod) ? appMod.createApp : undefined;
  if (typeof createApp !== 'function') return { error: 'src/app.ts does not export createApp()', probes: [] };
  const app: unknown = Reflect.apply(createApp, undefined, []);
  if (!isObject(app) && typeof app !== 'function') return { error: 'createApp() did not return an app', probes: [] };
  const table: unknown = Reflect.get(app, 'routeTable');

  let routes: ProbeRoute[];
  let source: ProbeOutput['source'];
  if (Array.isArray(table)) {
    source = 'routeTable';
    routes = table.filter(isObject).map((r) => ({ method: str(r.method).toLowerCase(), path: str(r.path), params: r.params, query: r.query, body: r.body }));
  } else if (input.astRoutes.length > 0) {
    source = 'ast';
    routes = [];
    for (const r of input.astRoutes) {
      routes.push({ method: r.method, path: r.path, params: await loadExport(input.apiRoot, r.params), query: await loadExport(input.apiRoot, r.query), body: await loadExport(input.apiRoot, r.body) });
    }
  } else {
    return { error: 'no route table on createApp() and no routes found statically', probes: [] };
  }

  const listen = Reflect.get(app, 'listen');
  if (typeof listen !== 'function') return { error: 'createApp() result has no listen()', probes: [] };
  const server: unknown = await new Promise((resolveServer) => {
    const s: unknown = Reflect.apply(listen, app, [0, '127.0.0.1', () => resolveServer(s)]);
  });
  if (!isObject(server) || typeof server.address !== 'function' || typeof server.close !== 'function') return { error: 'could not start the app', probes: [] };
  const address: unknown = Reflect.apply(server.address, server, []);
  const port = isObject(address) ? (address as unknown as AddressInfo).port : 0;
  const base = `http://127.0.0.1:${port}`;
  const probes: Probe[] = [];
  const record = async (route: string, family: string, method: string, path: string, allowed: number[], opts: Parameters<typeof send>[3] = {}) => {
    const sent = await send(base, method, path, opts);
    probes.push({ family, route, request: `${method.toUpperCase()} ${path}${opts.body !== undefined ? ` body=${opts.body}` : opts.json !== undefined ? ` json=${JSON.stringify(opts.json)}` : ''}`, status: sent.status, contentType: sent.contentType, body: sent.text.slice(0, 600), allowed, problems: judge(sent, allowed) });
    return sent;
  };

  try {
    const versions = [...new Set(['v1', ...routes.map((r) => r.path.split('/')[1] ?? 'v1')])];
    for (const v of versions) {
      await record('app', 'unknown-route', 'get', `/${v}/probe-unknown-route-${randomUUID().slice(0, 8)}`, [404]);
    }
    const byPath = new Map<string, Set<string>>();
    for (const r of routes) byPath.set(r.path, (byPath.get(r.path) ?? new Set()).add(r.method));

    for (const route of routes) {
      const label = `${route.method.toUpperCase()} ${route.path}`;
      const paramsSchema = jsonSchemaOf(toJson, route.params);
      const bodySchema = jsonSchemaOf(toJson, route.body);
      const params = Object.keys(isObject(paramsSchema?.properties) ? paramsSchema.properties : {});
      const paramNames = route.path.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));
      const unknownIds = Object.fromEntries(paramNames.map((p) => [p, sampleValue(isObject(paramsSchema?.properties) ? paramsSchema.properties[p] : undefined, p)]));
      const fill = (ids: Record<string, Json>) => route.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => encodeURIComponent(String(ids[name] ?? 'x')));
      const hasBody = ['post', 'put', 'patch'].includes(route.method);
      const validBody = bodySchema !== undefined ? sampleObject(bodySchema) : {};

      if (hasBody) {
        await record(label, 'malformed-json', route.method, fill(unknownIds), paramNames.length > 0 ? [400, 404] : [400], { body: '{"probe":' });
        await record(label, 'empty-body', route.method, fill(unknownIds), paramNames.length > 0 ? [400, 404, 422] : [400, 422]);
        if (bodySchema !== undefined && paramNames.length === 0) {
          const props = isObject(bodySchema.properties) ? bodySchema.properties : {};
          const required = Array.isArray(bodySchema.required) ? bodySchema.required.filter((r): r is string => typeof r === 'string') : [];
          for (const field of required) {
            const body: JsonObject = { ...sampleObject(bodySchema) };
            delete body[field];
            await record(label, 'missing-field', route.method, fill(unknownIds), [422], { json: body });
          }
          for (const field of Object.keys(props)) {
            await record(label, 'wrong-type', route.method, fill(unknownIds), [422], { json: { ...sampleObject(bodySchema), [field]: wrongValue(props[field]) } });
          }
        }
      }
      if (paramNames.length > 0) {
        const malformed = route.path.replace(/:([A-Za-z0-9_]+)/g, 'not%20a%20valid%20id%21');
        await record(label, 'malformed-id', route.method, malformed, [400, 404, 422], hasBody ? { json: validBody } : {});
        if (params.length > 0 || paramNames.length > 0) {
          await record(label, 'unknown-id', route.method, fill(unknownIds), hasBody ? [404, 422] : [404], hasBody ? { json: validBody } : {});
        }
      }
      if (route.method === 'get' && paramNames.length === 0) {
        await record(label, 'list-bounds', 'get', `${route.path}?limit=0`, [400, 422]);
        await record(label, 'list-bounds', 'get', `${route.path}?limit=10000`, [400, 422]);
        await record(label, 'list-bounds', 'get', `${route.path}?cursor=${encodeURIComponent('garbage!@#')}`, [400, 422]);
      }
      const used = byPath.get(route.path) ?? new Set<string>();
      const wrong = ['put', 'post', 'patch', 'delete', 'get'].find((m) => !used.has(m));
      if (wrong !== undefined && route === routes.find((r) => r.path === route.path)) {
        await record(label, 'wrong-method', wrong, fill(unknownIds), [404, 405]);
      }
      if (route.method === 'post' && paramNames.length === 0 && bodySchema !== undefined) {
        const key = `probe-${randomUUID()}`;
        const body = sampleObject(bodySchema);
        const first = await record(label, 'idempotency', 'post', route.path, [200, 201], { json: body, headers: { 'idempotency-key': key } });
        const replay = await record(label, 'idempotency', 'post', route.path, [first.status], { json: body, headers: { 'idempotency-key': key } });
        const last = probes.at(-1);
        if (last !== undefined && replay.text !== first.text) last.problems.push('replay body differs from the first response');
        const changed = { ...sampleObject(bodySchema) };
        await record(label, 'idempotency', 'post', route.path, [409], { json: changed, headers: { 'idempotency-key': key } });
        const unique = input.uniqueFields.filter((f) => Object.keys(isObject(bodySchema.properties) ? bodySchema.properties : {}).includes(f));
        if (unique.length > 0) {
          const dup = sampleObject(bodySchema);
          const created = await record(label, 'duplicate', 'post', route.path, [200, 201], { json: dup });
          if (created.status < 300) await record(label, 'duplicate', 'post', route.path, [409], { json: dup });
        }
      }
    }
  } finally {
    const close = server.close;
    await new Promise<void>((done) => {
      Reflect.apply(close, server, [() => done()]);
    });
  }
  return { ...(source === undefined ? {} : { source }), probes };
}

// Entry point: node --import tsx runner.ts <input.json>
const inputPath = process.argv[2];
if (inputPath !== undefined && process.argv[1] !== undefined && process.argv[1].endsWith('runner.ts')) {
  const input: ProbeInput = JSON.parse(readFileSync(inputPath, 'utf8')) as ProbeInput;
  let output: ProbeOutput;
  try {
    output = await probeApi(input);
  } catch (error) {
    output = { error: `probe crashed: ${error instanceof Error ? error.message : String(error)}`, probes: [] };
  }
  writeFileSync(input.outFile, JSON.stringify(output));
  process.exit(0);
}
