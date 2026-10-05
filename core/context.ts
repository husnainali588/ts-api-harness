// Context: system prompt, state card, message history (spec §5.5). Compaction and baseline front-loading
// live here too, so tools and plugins never know which mode is on.
import type { Message, ToolCall, ToolResult } from './driver.js';
import type { RunState } from './state.js';

export const SYSTEM_PROMPT = `You build or change a TypeScript REST API inside a harness.
- You act only through the tools. You have no shell and no git.
- Paths are relative to the API root, your whole workspace. Nothing outside it exists for you.
- Hooks enforce the rules. A blocked call returns the reason and the fix: apply the fix, then retry.
- Loop for every source file: write a test -> run_tests (see it fail) -> write the source -> run_tests (see it pass) -> run_checks -> finish.
- A file under src/ can be written only after a mapped test (test/<same path>.test.ts, or a test importing it) was seen failing by run_tests.
- The run ends only when finish passes the gates: all tests green, strict tsc clean, standards checks at 100%.
- Fetch only what the next step needs: get_task, list_files, read_file with line ranges, search_code, get_standard.
- Prefer edit_file for small changes. Keep outputs short.`;

export interface ContextOptions {
  brief: string;
  apiRel: string;
  /** Baseline mode: everything the fetchers could return, front-loaded into the system prompt. */
  frontLoad?: string;
  /** Number of most recent exchanges kept verbatim (compaction); undefined = no compaction. */
  keepExchanges?: number;
}

const ELIDE_OVER = 200;

/** Long strings inside old tool-call inputs (e.g. written file content) become a short marker. */
export function elideInput(value: unknown): unknown {
  if (typeof value === 'string') return value.length > ELIDE_OVER ? `[${value.length} chars elided from history]` : value;
  if (Array.isArray(value)) return value.map(elideInput);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elideInput(v)]));
  return value;
}

export class Context {
  private readonly history: Message[] = [];
  private readonly stubs = new Map<string, string>(); // tool callId → one-line stub used once compacted
  private nudged = false;

  constructor(
    private readonly state: RunState,
    private readonly opts: ContextOptions,
  ) {}

  system(): string {
    return this.opts.frontLoad === undefined ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\n# Workspace and reference material\n${this.opts.frontLoad}`;
  }

  /** Baseline mode refreshes the front-loaded material every turn, so it always reflects the workspace. */
  setFrontLoad(text: string): void {
    this.opts.frontLoad = text;
  }

  stateCard(turn: number): string {
    const s = this.state;
    const list = (items: readonly string[]) => (items.length === 0 ? 'none' : items.join(', '));
    return [
      `State (turn ${turn}):`,
      `- API root: ${this.opts.apiRel}`,
      `- files written: ${list(s.writtenFiles)}`,
      `- last tests: ${s.lastTest ?? 'not run yet'}`,
      `- last checks: ${s.lastCheck ?? 'not run yet'}`,
      `- open blocks: ${list(s.openBlocks.slice(-3))}`,
      `- red tests awaiting green: ${list(s.redCases.map((c) => `${c.file} › ${c.name}`).slice(0, 8))}`,
    ].join('\n');
  }

  addAssistant(text: string, toolCalls: ToolCall[]): void {
    this.history.push({ role: 'assistant', text, toolCalls });
  }

  addToolResults(results: ToolResult[], stubs: Record<string, string>): void {
    for (const [id, stub] of Object.entries(stubs)) this.stubs.set(id, stub);
    this.history.push({ role: 'tool', results });
  }

  addUser(content: string): void {
    this.history.push({ role: 'user', content });
  }

  /** One nudge per run when the model answers without tool calls. Returns false if already nudged. */
  nudge(): boolean {
    if (this.nudged) return false;
    this.nudged = true;
    this.addUser('Act through tools; call finish when done.');
    return true;
  }

  /** Messages for the next turn: brief + fresh state card first, then history (compacted in actual mode). */
  render(turn: number): Message[] {
    const first: Message = { role: 'user', content: `${this.opts.brief}\n\n${this.stateCard(turn)}` };
    const keep = this.opts.keepExchanges;
    if (keep === undefined) return [first, ...this.history];
    // An exchange = an assistant message and the tool results that follow it.
    let exchanges = 0;
    let cutoff = 0;
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (this.history[i]?.role === 'assistant') {
        exchanges += 1;
        if (exchanges === keep) {
          cutoff = i;
          break;
        }
      }
    }
    let lastAssistant = -1;
    for (let i = this.history.length - 1; i >= 0 && lastAssistant < 0; i -= 1) if (this.history[i]?.role === 'assistant') lastAssistant = i;
    const compacted = this.history.map((msg, i): Message => {
      // Large tool-call inputs (e.g. file content the model wrote) are elided from every exchange but the latest:
      // the result already says what was written, and read_file brings it back if needed.
      if (msg.role === 'assistant') return i === lastAssistant ? msg : { ...msg, toolCalls: msg.toolCalls.map((c) => ({ ...c, input: elideInput(c.input) })) };
      if (i >= cutoff || msg.role !== 'tool') return msg;
      return {
        role: 'tool',
        results: msg.results.map((r) => ({ ...r, content: this.stubs.get(r.callId) ?? `[${r.content.slice(0, 60)}… — dropped, re-run if needed]` })),
      };
    });
    return [first, ...compacted];
  }

  /** Count of tool results currently replaced by stubs (token-report mechanism). */
  stubbedResults(): number {
    const keep = this.opts.keepExchanges;
    if (keep === undefined) return 0;
    const rendered = this.render(0);
    return rendered.reduce((n, m) => n + (m.role === 'tool' ? m.results.filter((r) => r.content.startsWith('[')).length : 0), 0);
  }
}
