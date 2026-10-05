// Task loader (spec §4, docs/decisions.md). Built around our task format — top-level resource, fields,
// behaviours (+ api for brownfield) — and deliberately tolerant of small differences in a grader's file.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import pluralize from 'pluralize';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

const FieldSpec = z.looseObject({
  type: z.string().min(1).default('string'),
  required: z.boolean().optional(),
  optional: z.boolean().optional(),
  unique: z.boolean().optional(),
  generated: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  minLength: z.number().optional(),
  maxLength: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  values: z.array(Scalar).optional(),
  enum: z.array(Scalar).optional(),
  description: z.string().optional(),
});

const FieldEntry = z.union([z.string().min(1), FieldSpec]);
const FieldList = z.array(FieldSpec.extend({ name: z.string().min(1) }));
const FieldMap = z.record(z.string().min(1), FieldEntry.nullable());

const Behaviour = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

const RawTask = z.looseObject({
  resource: z.union([z.string().min(1), z.looseObject({ name: z.string().min(1) })]),
  fields: z.union([FieldMap, FieldList]).optional(),
  behaviours: z.array(Behaviour).optional(),
  behaviors: z.array(Behaviour).optional(),
  api: z.string().min(1).optional(),
  mode: z.enum(['greenfield', 'brownfield']).optional(),
});

export const TaskField = z.object({
  name: z.string(),
  type: z.string(),
  required: z.boolean(),
  unique: z.boolean(),
  generated: z.boolean(),
  constraints: z.record(z.string(), z.unknown()),
});
export type TaskField = z.infer<typeof TaskField>;

export const Task = z.object({
  path: z.string(), // as given (repo-relative when loaded from the repo)
  sha256: z.string(),
  mode: z.enum(['greenfield', 'brownfield']),
  resource: z.string(), // plural, lower-case, e.g. "users"
  singular: z.string(), // e.g. "user"
  api: z.string().optional(), // brownfield: path of the existing API root
  fields: z.array(TaskField),
  behaviours: z.array(z.string()),
  extra: z.record(z.string(), z.unknown()), // unknown keys, kept and shown to the model
  text: z.string(), // the file content, verbatim
});
export type Task = z.infer<typeof Task>;

export class TaskError extends Error {}

const KNOWN_KEYS = new Set(['resource', 'fields', 'behaviours', 'behaviors', 'api', 'mode']);
const FIELD_KEYS = new Set(['type', 'required', 'optional', 'unique', 'generated', 'readOnly', 'name']);

function normaliseField(name: string, entry: z.infer<typeof FieldEntry> | null): TaskField {
  const spec = typeof entry === 'string' ? FieldSpec.parse({ type: entry }) : FieldSpec.parse(entry ?? {});
  const constraints: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(spec)) {
    if (!FIELD_KEYS.has(key) && value !== undefined) constraints[key] = value;
  }
  const generated = spec.generated === true || spec.readOnly === true;
  const required = spec.required ?? (spec.optional === true ? false : !generated);
  return { name, type: spec.type, required, unique: spec.unique === true, generated, constraints };
}

function behaviourText(entry: z.infer<typeof Behaviour>): string {
  return typeof entry === 'string' ? entry : stringifyYaml(entry).trim().replace(/\n\s*/g, '; ');
}

function parseContent(path: string, text: string): unknown {
  const ext = extname(path).toLowerCase();
  try {
    return ext === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new TaskError(`${path}: cannot parse task file (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** Normalises an already-parsed task document. */
export function normaliseTask(path: string, text: string, doc: unknown): Task {
  // A task may nest everything under `resource: { name, fields, behaviours }`.
  let flat: unknown = doc;
  if (typeof doc === 'object' && doc !== null && 'resource' in doc) {
    const resource = doc.resource;
    if (typeof resource === 'object' && resource !== null && !Array.isArray(resource)) {
      const { name, ...nested } = { name: undefined, ...resource };
      flat = { ...nested, ...doc, resource: name };
    }
  }
  const result = RawTask.safeParse(flat);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new TaskError(`${path}: not a task file — ${issues}`);
  }
  const raw = result.data;
  const resourceName = (typeof raw.resource === 'string' ? raw.resource : raw.resource.name).trim().toLowerCase();
  const resource = pluralize.plural(resourceName);
  const fields = Array.isArray(raw.fields)
    ? raw.fields.map((f) => normaliseField(f.name, f))
    : Object.entries(raw.fields ?? {}).map(([name, entry]) => normaliseField(name, entry));
  const behaviours = [...(raw.behaviours ?? []), ...(raw.behaviors ?? [])].map(behaviourText);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(key)) extra[key] = value;
  }
  const mode = raw.mode ?? (raw.api === undefined ? 'greenfield' : 'brownfield');
  if (mode === 'brownfield' && raw.api === undefined) {
    throw new TaskError(`${path}: a brownfield task needs an "api" key with the existing API's path`);
  }
  return Task.parse({
    path,
    sha256: createHash('sha256').update(text).digest('hex'),
    mode,
    resource,
    singular: pluralize.singular(resource),
    ...(raw.api === undefined ? {} : { api: raw.api }),
    fields,
    behaviours,
    extra,
    text,
  });
}

/** Loads a task file (.yaml, .yml or .json). `path` is resolved against `cwd`. */
export function loadTask(path: string, cwd: string = process.cwd()): Task {
  let text: string;
  try {
    text = readFileSync(resolve(cwd, path), 'utf8');
  } catch {
    throw new TaskError(`${path}: task file not found`);
  }
  return normaliseTask(path, text, parseContent(path, text));
}

/** Compact, provider-neutral brief for the model's first message. */
export function renderTaskBrief(task: Task): string {
  const lines = [`Task (${task.mode}): ${task.resource}`];
  if (task.api !== undefined) lines.push(`Existing API: the workspace root is a copy of ${task.api}.`);
  lines.push('Fields:');
  for (const f of task.fields) {
    const flags = [f.required ? 'required' : 'optional', f.unique ? 'unique' : '', f.generated ? 'server-generated' : '']
      .filter((s) => s !== '')
      .join(', ');
    const constraints = Object.entries(f.constraints)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    lines.push(`- ${f.name}: ${f.type} (${flags})${constraints === '' ? '' : ` ${constraints}`}`);
  }
  lines.push('Behaviours:');
  for (const b of task.behaviours) lines.push(`- ${b}`);
  if (Object.keys(task.extra).length > 0) lines.push(`Other task keys:\n${stringifyYaml(task.extra).trim()}`);
  return lines.join('\n');
}
