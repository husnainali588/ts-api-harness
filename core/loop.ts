// The agent loop (spec §5.2). The model decides what to do; the harness decides whether it is allowed,
// whether it worked and whether the run is done.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { compactReport, runChecks } from './checks.js';
import { Context } from './context.js';
import { estimateRequestTokens, type ToolCall, type ToolResult, type ToolSpec, type TurnResponse } from './driver.js';
import { execTool } from './exec.js';
import { finishGate } from './finish.js';
import { blockMessage, runHooks } from './hooks.js';
import { findDriver, loadRegistry, type Registry } from './registry.js';
import type { HarnessServices, HookContext, ToolContext, ToolDefinition, ToolOutput } from './sdk.js';
import { Evidence, RunState, fingerprint } from './state.js';
import { loadTask, renderTaskBrief, type Task } from './task.js';
import { mappedTests, runTests } from './tests.js';
import { DEFAULT_MAX_RUN_TOKENS, MIN_REMAINING_TO_START, SpendLedger, TokenLedger, effectiveCap, isPaidModel } from './tokens.js';
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
  /** Total input-token budget across all paid live runs (spend ledger). */
  totalBudget?: number;
  spendFile?: string;
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
  cost: { paid: boolean; requestedModel: string | null; cap: number | null; spentBefore: number; spentAfter: number };
  prUrl: string | null;
  honesty: { proven: string[]; unproven: string[]; outOfReach: string[] };
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

const notAvailable = (what: string): Promise<ToolOutput> =>
  Promise.resolve({ summary: `${what} is not available in this harness build.`, isError: true });

export function harnessRunDir(run: RunContext): string {
  return join(run.repoRoot, '.harness', 'runs', run.runId);
}

const defaultServices = (run: RunContext): HarnessServices => ({
  runTests: () =>
    runTests({
      apiRoot: run.workspace.apiRoot,
      runDir: harnessRunDir(run),
      state: run.state,
      turn: run.turn,
      saveRaw: (label, content) => run.evidence.saveRaw(label, content),
    }),
  runChecks: async () => {
    const report = await runChecks({
      apiRoot: run.workspace.apiRoot,
      registry: run.registry,
      runId: run.runId,
      reportsRoot: run.repoRoot,
      task: run.task,
      saveRaw: (label, content) => run.evidence.saveRaw(label, content),
    });
    const summary = compactReport(report);
    run.state.lastCheck = `verdict ${report.verdictPct}%${report.green ? '' : ` — failing: ${report.rules.filter((r) => r.required && (r.status === 'fail' || r.status === 'unproven')).map((r) => r.id).join(', ')}`}`;
    return { summary, raw: report.text };
  },
  proposeScope: () => notAvailable('propose_scope'),
});

const defaultGate = (run: RunContext): Promise<GateResult> => finishGate(run);

function stubFor(call: ToolCall): string {
  const input = JSON.stringify(call.input) ?? '';
  return `[${call.name} ${input.length > 100 ? `${input.slice(0, 100)}…` : input} — dropped, re-run if needed]`;
}

/** Drops JSON-Schema noise that costs tokens every turn and tells the model nothing (safe-integer bounds). */
function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'maximum' || k === 'minimum') && typeof v === 'number' && Math.abs(v) >= Number.MAX_SAFE_INTEGER) continue;
    out[k] = compactSchema(v);
  }
  return out;
}

export function toolSpecs(tools: readonly ToolDefinition[]): ToolSpec[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: 'input' });
    const compact = compactSchema(schema);
    return { name: t.name, description: t.description, inputSchema: typeof compact === 'object' && compact !== null ? Object.fromEntries(Object.entries(compact)) : {} };
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
  let evidenceRef: Evidence | undefined;
  const driver = driverDef.create({
    env: opts.env ?? process.env,
    ...(opts.script === undefined ? {} : { script: opts.script }),
    rawLog: (entry) => evidenceRef?.driverLog(entry),
  });

  // Spend is capped by code (spec §1.10): the effective cap is min(per-run cap, budget remaining).
  const paid = isPaidModel(driver.model);
  const spend = new SpendLedger(opts.spendFile ?? join(opts.repoRoot, '.harness', 'spend.json'));
  const spentBefore = spend.spent();
  let cap = opts.maxRunTokens ?? (paid ? DEFAULT_MAX_RUN_TOKENS : undefined);
  if (paid && cap !== undefined) {
    const eff = effectiveCap(cap, opts.totalBudget, spentBefore);
    if (eff.remaining !== undefined && eff.remaining < MIN_REMAINING_TO_START) {
      throw new Error(`refusing to start a paid run: ${eff.remaining} input tokens left in the total budget (need at least ${MIN_REMAINING_TO_START})`);
    }
    cap = eff.cap;
  }

  const evidence = new Evidence(opts.repoRoot, runId);
  evidenceRef = evidence;
  const workspace = await createWorkspace({
    repoRoot: opts.repoRoot,
    task,
    runId,
    driverId: driverDef.id,
    templateDir: join(opts.harnessRoot, 'templates', 'api'),
    harnessRoot: opts.harnessRoot,
  });
  const state = new RunState();
  state.testMap = (source) => mappedTests(workspace.apiRoot, source);
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
  const fetchCtx = () => ({ apiRoot: workspace.apiRoot, harnessRoot: opts.harnessRoot, task, rules: registry.rules.map((r) => r.def) });
  /** Baseline front-load (spec §5.5): every text file under the API root (no node_modules, no lockfiles), the task
   * file, and every context plugin's frontLoad(). Never the harness's own source. */
  const buildFrontLoad = async (): Promise<string> => {
    const parts: string[] = [];
    const files = (await fg('**/*', { cwd: workspace.apiRoot, onlyFiles: true, dot: true, ignore: ['**/node_modules/**', '**/package-lock.json', '**/*.lock'] })).sort();
    for (const file of files) {
      const content = readFileSync(join(workspace.apiRoot, file), 'utf8');
      if (!content.includes('\0')) parts.push(`## ${file}\n${content}`);
    }
    parts.push(`# Task file ${task.path}\n${task.text}`);
    for (const c of registry.contexts) parts.push(`# ${c.def.name}\n${await c.def.frontLoad(fetchCtx())}`);
    return parts.join('\n\n');
  };
  const mechanisms = { jitFetches: 0, bytesNotFrontLoaded: 0, compactedToolReturns: 0, rawBytesDivertedToDisk: 0, historyStubs: 0, unchangedRereadsSkipped: 0 };
  const frontLoadBytes = Buffer.byteLength(await buildFrontLoad());
  if (!baseline) mechanisms.bytesNotFrontLoaded = frontLoadBytes;
  evidence.event({ type: 'run-start', runId, task: task.path, driver: driverDef.id, baseline, branch: workspace.branch, apiRoot: workspace.apiRel, frontLoadBytes });
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
      return found.def.fetch(key, fetchCtx());
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
    if (tool.fetch === true) mechanisms.jitFetches += 1;
    if (!baseline && out.raw !== undefined) {
      mechanisms.compactedToolReturns += 1;
      mechanisms.rawBytesDivertedToDisk += Buffer.byteLength(out.raw);
    }
    if (!baseline && out.cached === true) mechanisms.unchangedRereadsSkipped += 1;
    evidence.event({ type: 'tool', turn: run.turn, tool: call.name, callId: call.id, isError: out.isError === true, summary: out.summary.slice(0, 300), raw: rawPath, fetch: tool.fetch === true });
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
    if (baseline) context.setFrontLoad(await buildFrontLoad());
    const request = { system: context.system(), messages: context.render(run.turn), tools: specs, maxOutputTokens: opts.maxOutputTokens ?? 8192 };
    if (!baseline) mechanisms.historyStubs = Math.max(mechanisms.historyStubs, context.stubbedResults());
    if (cap !== undefined && ledger.totalInput() + estimateRequestTokens(request) > cap) {
      status = 'unproven';
      reason = `stopped by cost cap (${ledger.totalInput()} spent + ~${estimateRequestTokens(request)} next turn > ${cap} input tokens)`;
      break;
    }
    let res: TurnResponse;
    try {
      res = await driver.turn(request);
    } catch (e) {
      status = 'unproven';
      reason = `driver error: ${e instanceof Error ? e.message : String(e)}`;
      evidence.event({ type: 'driver-error', turn: run.turn, error: reason });
      break;
    }
    ledger.record(run.turn, res.usage);
    if (paid && !res.model.endsWith(':free')) {
      spend.add({ runId, driver: driverDef.id, model: res.model, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens });
    }
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
    if (cap !== undefined && ledger.totalInput() >= cap) {
      status = 'unproven';
      reason = `stopped by cost cap (${ledger.totalInput()} >= ${cap} input tokens)`;
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
    cost: { paid, requestedModel: driver.model ?? null, cap: cap ?? null, spentBefore, spentAfter: spend.spent() },
    prUrl: null,
    honesty: {
      proven: gate?.green === true ? gate.lines : [],
      unproven,
      outOfReach: ['business-logic correctness beyond the tests', 'test quality beyond red→green', 'security', 'performance', 'persistence semantics'],
    },
  };
  evidence.writeJson('summary.json', summary);
  evidence.writeJson('tokens.json', { runId, task: task.path, taskSha256: task.sha256, driver: driverDef.id, baseline, completed: status === 'green', stoppedBy: reason, transports: [...transports], servedBy: [...servedBy], turns: ledger.turns, totals, mechanisms });
  evidence.event({ type: 'run-end', status, reason });
  log(`run ${runId}: ${status.toUpperCase()} — ${reason} (${totals.turns} turns, ${totals.totalInputTokens} input tokens, ${totals.source})`);
  return summary;
}
