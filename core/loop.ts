// The agent loop (spec §5.2). The model decides what to do; the harness decides whether it is allowed,
// whether it worked and whether the run is done.
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Context } from './context.js';
import type { ToolCall, ToolResult, ToolSpec, TurnResponse } from './driver.js';
import { execTool } from './exec.js';
import { blockMessage, runHooks } from './hooks.js';
import { findDriver, loadRegistry, type Registry } from './registry.js';
import type { HarnessServices, HookContext, ToolContext, ToolDefinition, ToolOutput } from './sdk.js';
import { Evidence, RunState, fingerprint } from './state.js';
import { loadTask, renderTaskBrief, type Task } from './task.js';
import { TokenLedger } from './tokens.js';
import { createWorkspace, resolveInside, type Workspace } from './workspace.js';

export type RunStatus = 'green' | 'fail' | 'unproven';

export interface GateResult {
  green: boolean;
  lines: string[];
  unproven: string[];
}

export interface RunContext {
  readonly runId: string;
  readonly task: Task;
  readonly registry: Registry;
  readonly workspace: Workspace;
  readonly state: RunState;
  readonly evidence: Evidence;
  readonly harnessRoot: string;
  readonly repoRoot: string;
  turn: number;
}

export interface RunOptions {
  harnessRoot: string;
  repoRoot: string;
  taskPath: string; // relative to repoRoot
  driverId: string;
  baseline?: boolean;
  maxTurns?: number;
  maxConsecutiveBlocks?: number;
  maxOutputTokens?: number;
  maxRunTokens?: number;
  script?: string;
  runId?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Builds harness services (tests, checks, scope) for a run; later phases plug in real ones. */
  services?: (run: RunContext) => HarnessServices;
  /** The finish gate (G3). */
  finishGate?: (run: RunContext) => Promise<GateResult>;
  log?: (line: string) => void;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  reason: string;
  task: { path: string; sha256: string; mode: Task['mode'] };
  fingerprint: { sha256: string; files: number };
  driver: string;
  baseline: boolean;
  transports: string[];
  servedBy: string[];
  turns: number;
  tokens: ReturnType<TokenLedger['totals']>;
  branch: string;
  worktree: string;
  apiRoot: string; // relative to the worktree
  gate: GateResult | null;
  prUrl: string | null;
  honesty: { proven: string[]; unproven: string[]; outOfReach: string[] };
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

const notAvailable = (what: string): Promise<ToolOutput> =>
  Promise.resolve({ summary: `${what} is not available in this harness build.`, isError: true });

const defaultServices = (): HarnessServices => ({
  runTests: () => notAvailable('run_tests'),
  runChecks: () => notAvailable('run_checks'),
  proposeScope: () => notAvailable('propose_scope'),
});

const defaultGate = async (): Promise<GateResult> => ({ green: false, lines: ['finish gate not configured'], unproven: ['finish gate'] });

function stubFor(call: ToolCall): string {
  const input = JSON.stringify(call.input) ?? '';
  return `[${call.name} ${input.length > 100 ? `${input.slice(0, 100)}…` : input} — dropped, re-run if needed]`;
}

export function toolSpecs(tools: readonly ToolDefinition[]): ToolSpec[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: 'input' });
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

export async function runHarness(opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? (() => {});
  const baseline = opts.baseline ?? false;
  const maxTurns = opts.maxTurns ?? 40;
  const maxBlocks = opts.maxConsecutiveBlocks ?? 6;
  const registry = await loadRegistry(opts.harnessRoot);
  const task = loadTask(opts.taskPath, opts.repoRoot);
  const driverDef = findDriver(registry, opts.driverId).def;
  const runId = opts.runId ?? newRunId();
  const evidence = new Evidence(opts.repoRoot, runId);
  const driver = driverDef.create({
    env: opts.env ?? process.env,
    ...(opts.script === undefined ? {} : { script: opts.script }),
    rawLog: (entry) => evidence.driverLog(entry),
  });
  const workspace = await createWorkspace({
    repoRoot: opts.repoRoot,
    task,
    runId,
    driverId: driverDef.id,
    templateDir: join(opts.harnessRoot, 'templates', 'api'),
  });
  const state = new RunState();
  const run: RunContext = { runId, task, registry, workspace, state, evidence, harnessRoot: opts.harnessRoot, repoRoot: opts.repoRoot, turn: 0 };
  const services = (opts.services ?? defaultServices)(run);
  const finishGate = opts.finishGate ?? defaultGate;
  const ledger = new TokenLedger();
  const tools = registry.tools.map((t) => t.def);
  const specs = toolSpecs(tools);
  const context = new Context(state, {
    brief: renderTaskBrief(task),
    apiRel: workspace.apiRel,
    ...(baseline ? {} : { keepExchanges: 6 }),
  });
  const transports = new Set<string>();
  const servedBy = new Set<string>();
  evidence.event({ type: 'run-start', runId, task: task.path, driver: driverDef.id, baseline, branch: workspace.branch, apiRoot: workspace.apiRel });
  log(`run ${runId}: ${task.path} with driver ${driverDef.id}${baseline ? ' (baseline)' : ''}`);

  const toolCtx = (tool: ToolDefinition): ToolContext => ({
    runId,
    turn: run.turn,
    apiRoot: workspace.apiRoot,
    harnessRoot: opts.harnessRoot,
    task,
    state,
    resolvePath: (rel) => resolveInside(workspace.apiRoot, rel),
    exec: (file, args, o) => execTool(file, args, { cwd: workspace.apiRoot, ...o }),
    context: async (name, key) => {
      const found = registry.contexts.find((c) => c.def.name === name);
      if (found === undefined) return `unknown context "${name}"`;
      return found.def.fetch(key, { apiRoot: workspace.apiRoot, harnessRoot: opts.harnessRoot, task, rules: registry.rules.map((r) => r.def) });
    },
    saveRaw: (label, content) => evidence.saveRaw(label, content),
    memory: state.toolMemory(tool.name),
    services,
  });

  async function handleCall(call: ToolCall): Promise<{ result: ToolResult; stub: string; blocked: boolean; finish: GateResult | null }> {
    const error = (content: string, blocked = false) => ({ result: { callId: call.id, content, isError: true }, stub: stubFor(call), blocked, finish: null });
    const tool = tools.find((t) => t.name === call.name);
    if (tool === undefined) {
      evidence.event({ type: 'tool', turn: run.turn, tool: call.name, callId: call.id, error: 'unknown tool' });
      return error(`Unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(', ')}.`);
    }
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');
      evidence.event({ type: 'tool', turn: run.turn, tool: call.name, callId: call.id, error: `invalid input: ${issues}` });
      return error(`Invalid input for ${call.name}: ${issues}. Fix the arguments and retry.`);
    }
    const base = toolCtx(tool);
    const hookCtx: HookContext = { ...base, tool, input: parsed.data };
    const pre = await runHooks('pre', registry.hooks, call, hookCtx, (e) => evidence.event({ turn: run.turn, ...e }));
    if (pre.blocked !== null) {
      state.openBlocks.push(`${pre.blocked.hook}: ${pre.blocked.reason}`);
      return error(blockMessage(pre.blocked), true);
    }
    let out: ToolOutput;
    try {
      out = await tool.run(parsed.data, base);
    } catch (e) {
      out = { summary: `${call.name} failed: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    for (const rel of out.wrote ?? []) state.recordWrite(rel);
    const post = await runHooks('post', registry.hooks, call, { ...hookCtx, output: out }, (e) => evidence.event({ turn: run.turn, ...e }));
    const rawPath = out.raw === undefined ? undefined : evidence.saveRaw(call.name, out.raw);
    evidence.event({ type: 'tool', turn: run.turn, tool: call.name, callId: call.id, isError: out.isError === true, summary: out.summary.slice(0, 300), raw: rawPath });
    // Record notes go to events.jsonl only; they cost the model no tokens.
    let content = baseline ? (out.raw ?? out.summary) : rawPath === undefined ? out.summary : `${out.summary}\n(full output kept by the harness: ${rawPath})`;
    if (post.blocked !== null) content += `\n${blockMessage(post.blocked)}`;
    let finish: GateResult | null = null;
    let isError = out.isError === true || post.blocked !== null;
    if (out.signal === 'finish' && !isError) {
      finish = await finishGate(run);
      evidence.event({ type: 'finish-gate', turn: run.turn, green: finish.green, lines: finish.lines, unproven: finish.unproven });
      content = finish.green ? `Finish gate: GREEN\n${finish.lines.join('\n')}` : `Finish gate: NOT GREEN — fix these, then call finish again:\n${finish.lines.join('\n')}`;
      isError = !finish.green;
    }
    return { result: { callId: call.id, content, isError }, stub: out.stub ?? stubFor(call), blocked: false, finish };
  }

  let status: RunStatus = 'unproven';
  let reason = `turn budget exhausted (${maxTurns} turns)`;
  let gate: GateResult | null = null;
  let consecutiveBlocks = 0;
  loop: for (run.turn = 1; run.turn <= maxTurns; run.turn += 1) {
    let res: TurnResponse;
    try {
      res = await driver.turn({ system: context.system(), messages: context.render(run.turn), tools: specs, maxOutputTokens: opts.maxOutputTokens ?? 8192 });
    } catch (e) {
      status = 'unproven';
      reason = `driver error: ${e instanceof Error ? e.message : String(e)}`;
      evidence.event({ type: 'driver-error', turn: run.turn, error: reason });
      break;
    }
    ledger.record(run.turn, res.usage);
    transports.add(res.transport);
    servedBy.add(res.model);
    evidence.transcript({ turn: run.turn, response: res });
    evidence.event({ type: 'turn', turn: run.turn, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, usageSource: res.usage.source, toolCalls: res.toolCalls.map((c) => c.name), stop: res.stop });
    context.addAssistant(res.text, res.toolCalls);

    if (res.toolCalls.length === 0) {
      if (!context.nudge()) {
        status = 'fail';
        reason = 'the model stopped without calling finish';
        break;
      }
    } else {
      const results: ToolResult[] = [];
      const stubs: Record<string, string> = {};
      for (const call of res.toolCalls) {
        const handled = await handleCall(call); // one at a time, fresh state each call
        results.push(handled.result);
        stubs[call.id] = handled.stub;
        consecutiveBlocks = handled.blocked ? consecutiveBlocks + 1 : 0;
        if (handled.finish !== null) {
          gate = handled.finish;
          if (gate.green) {
            context.addToolResults(results, stubs);
            status = 'green';
            reason = 'finish gate green';
            break loop;
          }
        }
      }
      context.addToolResults(results, stubs);
      if (consecutiveBlocks >= maxBlocks) {
        status = 'fail';
        reason = `${consecutiveBlocks} consecutive blocked calls`;
        break;
      }
    }
    if (opts.maxRunTokens !== undefined && ledger.totalInput() >= opts.maxRunTokens) {
      status = 'unproven';
      reason = `stopped by cost cap (${ledger.totalInput()} >= ${opts.maxRunTokens} input tokens)`;
      break;
    }
  }

  const totals = ledger.totals();
  const unproven: string[] = [];
  if (status !== 'green') unproven.push(`run: ${reason}`);
  if (totals.source !== 'provider') unproven.push('token numbers are estimates (scripted/replayed driver), not evidence');
  for (const u of gate?.unproven ?? []) unproven.push(u);
  const summary: RunSummary = {
    runId,
    status,
    reason,
    task: { path: task.path, sha256: task.sha256, mode: task.mode },
    fingerprint: fingerprint(opts.harnessRoot, resolve(opts.repoRoot, task.path)),
    driver: driverDef.id,
    baseline,
    transports: [...transports],
    servedBy: [...servedBy],
    turns: totals.turns,
    tokens: totals,
    branch: workspace.branch,
    worktree: evidence.rel(workspace.worktree),
    apiRoot: workspace.apiRel,
    gate,
    prUrl: null,
    honesty: {
      proven: gate?.green === true ? gate.lines : [],
      unproven,
      outOfReach: ['business-logic correctness beyond the tests', 'test quality beyond red→green', 'security', 'performance', 'persistence semantics'],
    },
  };
  evidence.writeJson('summary.json', summary);
  evidence.writeJson('tokens.json', { runId, turns: ledger.turns, totals });
  evidence.event({ type: 'run-end', status, reason });
  log(`run ${runId}: ${status.toUpperCase()} — ${reason} (${totals.turns} turns, ${totals.totalInputTokens} input tokens, ${totals.source})`);
  return summary;
}
