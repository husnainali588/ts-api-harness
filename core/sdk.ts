// Public plugin API (spec §5.4). Plugins import only from this file and core/driver.ts.
// Every define* validates its definition with Zod; the registry validates default exports again at load.
import type { Project, SourceFile, TypeChecker } from 'ts-morph';
import { z } from 'zod';
import { TOOL_NAME, type Driver, type ToolCall } from './driver.js';
import type { Task } from './task.js';

export type { Driver, ToolCall } from './driver.js';
export type { Task } from './task.js';
export { renderTaskBrief } from './task.js';

// ── shared runtime services ────────────────────────────────────────────────────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** execFile with an argument array; never a shell. Secrets are scrubbed from the child environment. */
export type Exec = (
  file: string,
  args: readonly string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: Readonly<Record<string, string>> },
) => Promise<ExecResult>;

export interface TestCaseObservation {
  file: string; // API-root-relative test file
  name: string; // full test name
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  failureKind?: string;
  fileSha256: string;
  turn: number;
}

/** Read-only view of the run's observation ledger (written only by the harness and the run_tests tool). */
export interface RunStateView {
  readonly writtenFiles: readonly string[];
  readonly observations: readonly TestCaseObservation[];
  readonly redCases: readonly { file: string; name: string }[];
  readonly acceptedScope: readonly string[] | null; // brownfield; null = greenfield / not yet proposed
  lastTestSummary(): string | undefined;
  lastCheckSummary(): string | undefined;
  /** Test files (API-root-relative) mapped to a source file via imports and the src↔test naming convention. */
  mappedTests(sourceFile: string): string[];
}

export interface ToolContext {
  readonly runId: string;
  readonly turn: number;
  readonly apiRoot: string; // absolute; the model workspace
  readonly harnessRoot: string; // absolute; the harness repo (never exposed to the model)
  readonly task: Task;
  readonly state: RunStateView;
  /** Absolute path for an API-root-relative path; throws if it escapes the workspace. */
  resolvePath(relative: string): string;
  exec: Exec;
  /** Calls a context plugin's fetch(). */
  context(name: string, key: string): Promise<string>;
  /** Stores raw output on disk; returns the repo-relative path to reference in summaries. */
  saveRaw(label: string, content: string): string;
  /** Scratch memory private to this tool for the whole run (e.g. a re-read cache). */
  readonly memory: Map<string, unknown>;
  /** Harness-side services a few built-in tools need (test runner, checks, scope). */
  readonly services: HarnessServices;
}

export interface HarnessServices {
  runTests(): Promise<ToolOutput>;
  runChecks(): Promise<ToolOutput>;
  proposeScope(files: string[], reason: string): Promise<ToolOutput>;
}

export interface ToolOutput {
  summary: string; // compact text the model sees
  raw?: string; // full output; goes to disk, referenced by path
  isError?: boolean;
  signal?: 'finish'; // the finish tool asks the loop to run the finish gate
  wrote?: string[]; // API-root-relative files this call wrote
  stub?: string; // one-line replacement once compaction drops this result
  cached?: boolean; // the summary elides content the model already has (e.g. an unchanged re-read)
}

// ── tools ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  readonly kind: 'tool';
  readonly name: string;
  readonly description: string;
  readonly input: S;
  /** Tools that only read never trigger write guards. Default false. */
  readonly writes?: boolean;
  /** Just-in-time context fetchers (counted in the token report). Default false. */
  readonly fetch?: boolean;
  run(input: z.output<S>, ctx: ToolContext): ToolOutput | Promise<ToolOutput>;
}

// ── hooks ─────────────────────────────────────────────────────────────────────────────────────────────

export type HookOutcome =
  | { decision: 'pass' }
  | { decision: 'record'; note: string }
  | { decision: 'block'; reason: string; fix: string };

export interface HookContext extends ToolContext {
  readonly tool: ToolDefinition;
  readonly input: unknown; // the parsed tool input
  readonly output?: ToolOutput; // post hooks only
}

export interface HookDefinition {
  readonly kind: 'hook';
  readonly id: string;
  readonly phase: 'pre' | 'post';
  readonly order: number;
  matches(call: ToolCall, ctx: HookContext): boolean;
  run(call: ToolCall, ctx: HookContext): HookOutcome | Promise<HookOutcome>;
}

// ── rules ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RuleFailure {
  line: number;
  col?: number;
  message: string;
  fix?: string;
}

export interface FileResult {
  checked: number;
  failures: RuleFailure[];
}

export interface ProjectFileResult extends FileResult {
  file: string; // API-root-relative
}

export type ProjectResult = { files: ProjectFileResult[] } | { unproven: string };

export interface RuleContext {
  readonly apiRoot: string;
  readonly project: Project;
  readonly checker: TypeChecker;
  readonly exec: Exec;
  readonly task?: Task;
  /** API-root-relative path of a ts-morph source file. */
  rel(file: SourceFile): string;
  /** Test files mapped to a source file (imports + naming convention), as G2 sees them. */
  mappedTests(source: string): string[];
  saveRaw(label: string, content: string): string;
}

export interface RuleDefinition {
  readonly kind: 'rule';
  readonly id: string;
  readonly description: string;
  readonly unit: string;
  readonly files: readonly string[];
  readonly required: boolean;
  /** 'ratio' prints "12/12 handlers"; 'count' prints the number of failures, e.g. "0 errors". Default 'ratio'. */
  readonly summary?: 'ratio' | 'count';
  check?(file: SourceFile, ctx: RuleContext): FileResult | Promise<FileResult>;
  checkProject?(ctx: RuleContext): ProjectResult | Promise<ProjectResult>;
}

// ── context fetchers ──────────────────────────────────────────────────────────────────────────────────

export interface ContextFetchContext {
  readonly apiRoot: string;
  readonly harnessRoot: string;
  readonly task: Task;
  readonly rules: readonly { id: string; description: string; unit: string }[];
}

export interface ContextDefinition {
  readonly kind: 'context';
  readonly name: string;
  readonly description: string;
  fetch(key: string, ctx: ContextFetchContext): string | Promise<string>;
  frontLoad(ctx: ContextFetchContext): string | Promise<string>;
}

// ── drivers ───────────────────────────────────────────────────────────────────────────────────────────

export interface DriverOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly script?: string; // scripted driver: path to a script or recorded transcript
  readonly rawLog?: (entry: Record<string, unknown>) => void; // driver.log (redacted by core)
}

export interface DriverDefinition {
  readonly kind: 'driver';
  readonly id: string;
  readonly description: string;
  /** Env var names that authenticate this driver (any one is enough). Empty = needs no key. */
  readonly envKeys: readonly string[];
  /** Optional env var names the driver reads (models, base URLs). Names only, for `harness doctor`. */
  readonly envVars: readonly string[];
  create(opts: DriverOptions): Driver;
}

export type PluginDefinition = ToolDefinition | HookDefinition | RuleDefinition | ContextDefinition | DriverDefinition;
export type PluginKind = PluginDefinition['kind'];

// ── validation ────────────────────────────────────────────────────────────────────────────────────────

const fn = z.custom<(...args: never[]) => unknown>((v) => typeof v === 'function', 'must be a function');
const zodSchema = z.custom<z.ZodType>(
  (v) => typeof v === 'object' && v !== null && 'safeParse' in v && typeof v.safeParse === 'function',
  'must be a Zod schema',
);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'lowercase letters, digits, "-" or "_" (max 64)');

const DefinitionSchemas = {
  tool: z.object({
    kind: z.literal('tool'),
    name: z.string().regex(TOOL_NAME, 'tool names must match ^[a-z0-9_]{1,64}$'),
    description: z.string().min(1),
    input: zodSchema,
    writes: z.boolean().optional(),
    fetch: z.boolean().optional(),
    run: fn,
  }),
  hook: z.object({
    kind: z.literal('hook'),
    id,
    phase: z.enum(['pre', 'post']),
    order: z.number().finite(),
    matches: fn,
    run: fn,
  }),
  rule: z
    .object({
      kind: z.literal('rule'),
      id,
      description: z.string().min(1),
      unit: z.string().min(1),
      files: z.array(z.string().min(1)).min(1),
      required: z.boolean(),
      summary: z.enum(['ratio', 'count']).optional(),
      check: fn.optional(),
      checkProject: fn.optional(),
    })
    .refine((r) => (r.check === undefined) !== (r.checkProject === undefined), 'define exactly one of check or checkProject'),
  context: z.object({
    kind: z.literal('context'),
    name: id,
    description: z.string().min(1),
    fetch: fn,
    frontLoad: fn,
  }),
  driver: z.object({
    kind: z.literal('driver'),
    id,
    description: z.string().min(1),
    envKeys: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
    envVars: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
    create: fn,
  }),
} as const;

export class PluginDefinitionError extends Error {}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(definition)'}: ${i.message}`).join('; ');
}

/** Validates any plugin definition; throws PluginDefinitionError with readable issues. */
export function validateDefinition(value: unknown, expectedKind?: PluginKind): PluginDefinition {
  const kindResult = z.object({ kind: z.enum(['tool', 'hook', 'rule', 'context', 'driver']) }).safeParse(value);
  if (!kindResult.success) {
    throw new PluginDefinitionError('default export is not a plugin definition (use defineTool/defineHook/defineRule/defineContext/defineDriver)');
  }
  const kind = kindResult.data.kind;
  if (expectedKind !== undefined && kind !== expectedKind) {
    throw new PluginDefinitionError(`expected a ${expectedKind} definition, got a ${kind}`);
  }
  const result = DefinitionSchemas[kind].safeParse(value);
  if (!result.success) throw new PluginDefinitionError(formatIssues(result.error));
  // The schemas only check shape; the value itself (with its typed methods) is what we return.
  return value as PluginDefinition;
}

// ── define* helpers ───────────────────────────────────────────────────────────────────────────────────

export function defineTool<S extends z.ZodType>(def: Omit<ToolDefinition<S>, 'kind'>): ToolDefinition<S> {
  const full: ToolDefinition<S> = { kind: 'tool', ...def };
  validateDefinition(full, 'tool');
  return full;
}

export function defineHook(def: Omit<HookDefinition, 'kind'>): HookDefinition {
  const full: HookDefinition = { kind: 'hook', ...def };
  validateDefinition(full, 'hook');
  return full;
}

export function defineRule(
  def: Omit<RuleDefinition, 'kind' | 'files' | 'required'> & { files?: readonly string[]; required?: boolean },
): RuleDefinition {
  const full: RuleDefinition = { ...def, kind: 'rule', files: def.files ?? ['src/**/*.ts'], required: def.required ?? true };
  validateDefinition(full, 'rule');
  return full;
}

export function defineContext(def: Omit<ContextDefinition, 'kind'>): ContextDefinition {
  const full: ContextDefinition = { kind: 'context', ...def };
  validateDefinition(full, 'context');
  return full;
}

export function defineDriver(
  def: Omit<DriverDefinition, 'kind' | 'envVars'> & { envVars?: readonly string[] },
): DriverDefinition {
  const full: DriverDefinition = { ...def, kind: 'driver', envVars: def.envVars ?? [] };
  validateDefinition(full, 'driver');
  return full;
}
