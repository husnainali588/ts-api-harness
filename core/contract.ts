// Contract gate (spec §8): snapshot the API's route table + request/response JSON Schemas, then diff
// before/after. Breaking: removed route/field/status, narrowed type, new required request field, removed enum value.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from 'ts-morph';
import { allRoutes, routeRefs } from './analysis.js';
import type { Contract, ContractInput, JsonSchema } from './contract-runner.js';
import { exec } from './exec.js';

const RUNNER = fileURLToPath(new URL('./contract-runner.ts', import.meta.url));

export async function snapshotContract(apiRoot: string, workDir: string): Promise<Contract | { error: string }> {
  const tsconfig = join(apiRoot, 'tsconfig.json');
  const project = existsSync(tsconfig) ? new Project({ tsConfigFilePath: tsconfig }) : new Project();
  if (!existsSync(tsconfig)) project.addSourceFilesAtPaths(join(apiRoot, 'src/**/*.ts'));
  mkdirSync(workDir, { recursive: true });
  const id = randomUUID();
  const input: ContractInput = { apiRoot, astRoutes: allRoutes(project, apiRoot).map((r) => routeRefs(r, apiRoot)), outFile: join(workDir, `${id}.contract.out.json`) };
  const inFile = join(workDir, `${id}.contract.in.json`);
  writeFileSync(inFile, JSON.stringify(input));
  const res = await exec(process.execPath, ['--import', import.meta.resolve('tsx'), RUNNER, inFile], { cwd: apiRoot, timeoutMs: 120_000 });
  rmSync(inFile, { force: true });
  if (!existsSync(input.outFile)) return { error: `contract runner failed (exit ${res.code}): ${res.stderr.split('\n')[0] ?? ''}` };
  const out: unknown = JSON.parse(readFileSync(input.outFile, 'utf8'));
  rmSync(input.outFile, { force: true });
  return out as Contract | { error: string };
}

export interface ContractDiff {
  breaking: string[];
  additive: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (s: JsonSchema): string => (Array.isArray(s.type) ? s.type.join('|') : typeof s.type === 'string' ? s.type : Array.isArray(s.anyOf) ? 'anyOf' : 'any');
const requiredOf = (s: JsonSchema): string[] => (Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === 'string') : []);
const propsOf = (s: JsonSchema): Record<string, unknown> => (isObject(s.properties) ? s.properties : {});

/** Diffs one schema. `dir` = request (what clients send) or response (what clients receive). */
function diffSchema(before: unknown, after: unknown, dir: 'request' | 'response', at: string, out: ContractDiff): void {
  if (!isObject(before)) return;
  if (!isObject(after)) {
    out.breaking.push(`${at}: schema removed`);
    return;
  }
  const tb = typeOf(before);
  const ta = typeOf(after);
  if (tb !== ta && tb !== 'any') {
    out.breaking.push(`${at}: type changed ${tb} → ${ta}`);
    return;
  }
  if (Array.isArray(before.enum)) {
    const afterEnum = Array.isArray(after.enum) ? after.enum : [];
    for (const v of before.enum) if (!afterEnum.includes(v)) out.breaking.push(`${at}: enum value ${JSON.stringify(v)} removed`);
    for (const v of afterEnum) if (!before.enum.includes(v)) out.additive.push(`${at}: enum value ${JSON.stringify(v)} added`);
  }
  if (dir === 'request') {
    const narrowed = (k: string, worse: (b: number, a: number) => boolean) => {
      const b = before[k];
      const a = after[k];
      if (typeof a === 'number' && (typeof b !== 'number' || worse(b, a))) out.breaking.push(`${at}: ${k} narrowed to ${a}`);
    };
    narrowed('maxLength', (b, a) => a < b);
    narrowed('maximum', (b, a) => a < b);
    narrowed('minLength', (b, a) => a > b);
    narrowed('minimum', (b, a) => a > b);
  }
  if (tb === 'object') {
    const pb = propsOf(before);
    const pa = propsOf(after);
    const rb = requiredOf(before);
    const ra = requiredOf(after);
    for (const key of Object.keys(pb)) {
      const field = `${at}.${key}`;
      if (!(key in pa)) {
        if (dir === 'response') out.breaking.push(`${field}: field removed`);
        else if (after.additionalProperties === false) out.breaking.push(`${field}: request field no longer accepted`);
        continue;
      }
      if (dir === 'response' && rb.includes(key) && !ra.includes(key)) out.breaking.push(`${field}: field became optional`);
      if (dir === 'request' && !rb.includes(key) && ra.includes(key)) out.breaking.push(`${field}: request field became required`);
      diffSchema(pb[key], pa[key], dir, field, out);
    }
    for (const key of Object.keys(pa)) {
      if (key in pb) continue;
      const field = `${at}.${key}`;
      if (dir === 'request' && ra.includes(key)) out.breaking.push(`${field}: new required request field`);
      else out.additive.push(`${field}: new ${dir === 'request' ? 'optional request' : 'response'} field`);
    }
  }
  if (tb === 'array') diffSchema(before.items, after.items, dir, `${at}[]`, out);
}

export function diffContracts(before: Contract, after: Contract): ContractDiff {
  const out: ContractDiff = { breaking: [], additive: [] };
  for (const rb of before.routes) {
    const ra = after.routes.find((r) => r.key === rb.key);
    if (ra === undefined) {
      out.breaking.push(`${rb.key}: route removed`);
      continue;
    }
    for (const part of ['params', 'query', 'body'] as const) diffSchema(rb[part], ra[part], 'request', `${rb.key} ${part}`, out);
    for (const [status, schema] of Object.entries(rb.responses)) {
      if (!(status in ra.responses)) out.breaking.push(`${rb.key}: response ${status} removed`);
      else diffSchema(schema, ra.responses[status], 'response', `${rb.key} ${status}`, out);
    }
    for (const status of Object.keys(ra.responses)) if (!(status in rb.responses)) out.additive.push(`${rb.key}: new response ${status}`);
  }
  for (const ra of after.routes) if (!before.routes.some((r) => r.key === ra.key)) out.additive.push(`${ra.key}: new route`);
  return out;
}
