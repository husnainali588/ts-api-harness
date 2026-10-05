// Driver contract (spec §5.1). Neutral types only: every vendor shape lives in drivers/.

export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string; // ^[a-z0-9_]{1,64}$
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export interface TurnRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens: number;
}

export interface Usage {
  inputTokens: number; // full context processed this turn, cached + uncached
  outputTokens: number;
  source: 'provider' | 'estimate';
}

/** How a turn was served: 'native' / 'gateway' for live transports, 'local' for scripted or replayed turns. */
export type Transport = 'native' | 'gateway' | 'local';

export interface TurnResponse {
  text: string;
  toolCalls: ToolCall[];
  stop: 'tool_calls' | 'end' | 'length';
  usage: Usage;
  transport: Transport;
  model: string; // the model id reported by the response that served this turn
}

export interface Driver {
  readonly id: string;
  /** The model id requested from a live provider; absent for local (scripted/replay) drivers, which cost nothing. */
  readonly model?: string;
  turn(req: TurnRequest): Promise<TurnResponse>;
}

export const TOOL_NAME = /^[a-z0-9_]{1,64}$/;

/** Rough token estimate used wherever a provider count is unavailable. Never evidence. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateRequestTokens(req: TurnRequest): number {
  return estimateTokens(req.system) + estimateTokens(JSON.stringify(req.messages)) + estimateTokens(JSON.stringify(req.tools));
}
