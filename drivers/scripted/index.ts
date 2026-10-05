// Deterministic, free driver. Plays a script of tool calls, or replays a recorded live transcript, so the harness
// can be tested and debugged without spend. Its token numbers are estimates and never count as evidence.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { estimateRequestTokens, type Driver, type ToolCall, type TurnRequest, type TurnResponse } from '../../core/driver.js';
import { defineDriver } from '../../core/sdk.js';

// One JSON object per line. Script lines: { "text"?, "toolCalls": [{ "name", "input", "id"? }] }.
// Recorded transcript lines ({ "turn", "response": TurnResponse }) are accepted too; only the response is replayed.
const ScriptCall = z.object({ name: z.string(), input: z.unknown(), id: z.string().optional() });
const ScriptTurn = z.object({ text: z.string().default(''), toolCalls: z.array(ScriptCall).default([]) });
const TranscriptLine = z.object({ response: ScriptTurn });
const Line = z.union([TranscriptLine.transform((l) => l.response), ScriptTurn]);
export type ScriptTurn = z.infer<typeof ScriptTurn>;

export function parseScript(text: string, source = 'script'): ScriptTurn[] {
  return text
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line !== '' && !line.startsWith('//'))
    .map(({ line, index }) => {
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new Error(`${source}:${index + 1}: not valid JSON`);
      }
      const result = Line.safeParse(json);
      if (!result.success) throw new Error(`${source}:${index + 1}: ${result.error.issues[0]?.message ?? 'invalid line'}`);
      return result.data;
    });
}

export class ScriptedDriver implements Driver {
  readonly id = 'scripted';
  private turnIndex = 0;

  constructor(private readonly turns: readonly ScriptTurn[]) {}

  async turn(req: TurnRequest): Promise<TurnResponse> {
    const scripted = this.turns[this.turnIndex];
    const turnNo = this.turnIndex + 1;
    this.turnIndex += 1;
    const usage = { inputTokens: estimateRequestTokens(req), outputTokens: 0, source: 'estimate' as const };
    if (scripted === undefined) {
      return { text: '', toolCalls: [], stop: 'end', usage, transport: 'local', model: 'scripted' };
    }
    const toolCalls: ToolCall[] = scripted.toolCalls.map((call, i) => ({
      id: call.id ?? `call_${turnNo}_${i + 1}`,
      name: call.name,
      input: call.input,
    }));
    usage.outputTokens = Math.ceil(JSON.stringify(scripted).length / 4);
    return { text: scripted.text, toolCalls, stop: toolCalls.length > 0 ? 'tool_calls' : 'end', usage, transport: 'local', model: 'scripted' };
  }
}

export default defineDriver({
  id: 'scripted',
  description: 'Deterministic scripted/replay driver (free; token numbers are estimates)',
  envKeys: [],
  envVars: ['HARNESS_SCRIPT'],
  create(opts) {
    const path = opts.script ?? opts.env.HARNESS_SCRIPT;
    if (path === undefined || path === '') {
      throw new Error('the scripted driver needs a script: pass --script <file.jsonl> or set HARNESS_SCRIPT');
    }
    return new ScriptedDriver(parseScript(readFileSync(path, 'utf8'), path));
  },
});
