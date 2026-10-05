// Claude driver: Anthropic Messages wire format on both transports.
//   native  — ANTHROPIC_API_KEY, api.anthropic.com
//   gateway — OPENROUTER_API_KEY, https://openrouter.ai/api (Messages-compatible endpoint), Bearer auth
// Everything vendor-specific stays here: message/tool translation, retries, model ids, usage normalisation.
import Anthropic from '@anthropic-ai/sdk';
import type { Driver, Message, ToolSpec, Transport, TurnRequest, TurnResponse } from '../../core/driver.js';
import { defineDriver, type DriverOptions } from '../../core/sdk.js';

export const GATEWAY_BASE_URL = 'https://openrouter.ai/api';
export const DEFAULT_MODELS = { native: 'claude-haiku-4-5-20251001', gateway: 'anthropic/claude-haiku-4.5' } as const;

type Block = Anthropic.ContentBlockParam;

/** Neutral messages → Anthropic messages. Consecutive tool results are batched into one user message. */
export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const last = out.at(-1);
    if (last !== undefined && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.content }]);
    else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      if (m.text !== '') blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(no output)' });
      push('assistant', blocks);
    } else {
      push(
        'user',
        m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.callId, content: r.content === '' ? '(empty)' : r.content, is_error: r.isError })),
      );
    }
  }
  return out;
}

export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object', ...t.inputSchema } }));
}

export function fromAnthropicResponse(res: Anthropic.Message, transport: Transport): TurnResponse {
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const toolCalls = res.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : []));
  const u = res.usage;
  // Input tokens = the full context processed this turn: uncached + cache writes + cache reads.
  const inputTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  const stop = toolCalls.length > 0 ? 'tool_calls' : res.stop_reason === 'max_tokens' ? 'length' : 'end';
  return { text, toolCalls, stop, usage: { inputTokens, outputTokens: u.output_tokens, source: 'provider' }, transport, model: res.model };
}

export interface ClaudeConfig {
  transport: Exclude<Transport, 'local'>;
  apiKey: string;
  model: string;
  baseURL?: string;
}

export function claudeConfig(env: DriverOptions['env']): ClaudeConfig {
  const native = env.ANTHROPIC_API_KEY ?? '';
  const gateway = env.OPENROUTER_API_KEY ?? '';
  if (native !== '') return { transport: 'native', apiKey: native, model: env.HARNESS_CLAUDE_MODEL || DEFAULT_MODELS.native };
  if (gateway !== '') return { transport: 'gateway', apiKey: gateway, model: env.HARNESS_CLAUDE_MODEL || DEFAULT_MODELS.gateway, baseURL: GATEWAY_BASE_URL };
  throw new Error('claude driver: no key — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY');
}

export class ClaudeDriver implements Driver {
  readonly id = 'claude';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(
    readonly config: ClaudeConfig,
    private readonly log: DriverOptions['rawLog'] = () => {},
    fetchImpl?: typeof fetch,
  ) {
    this.model = config.model;
    const common = { maxRetries: 5, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) };
    this.client =
      config.transport === 'native'
        ? new Anthropic({ ...common, apiKey: config.apiKey, authToken: null, baseURL: 'https://api.anthropic.com' })
        : new Anthropic({ ...common, apiKey: null, authToken: config.apiKey, baseURL: config.baseURL ?? GATEWAY_BASE_URL });
  }

  async turn(req: TurnRequest): Promise<TurnResponse> {
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.config.model,
      max_tokens: req.maxOutputTokens,
      system: req.system,
      messages: toAnthropicMessages(req.messages),
      tools: toAnthropicTools(req.tools),
    };
    this.log?.({ dir: 'request', transport: this.config.transport, model: this.config.model, messages: body.messages.length, tools: req.tools.length });
    const res = await this.client.messages.create(body);
    this.log?.({ dir: 'response', id: res.id, model: res.model, stop: res.stop_reason, usage: res.usage });
    return fromAnthropicResponse(res, this.config.transport);
  }
}

export default defineDriver({
  id: 'claude',
  description: 'Claude via the Messages API (native key or OpenRouter gateway)',
  envKeys: ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'],
  envVars: ['HARNESS_CLAUDE_MODEL'],
  create: (opts) => new ClaudeDriver(claudeConfig(opts.env), opts.rawLog),
});
