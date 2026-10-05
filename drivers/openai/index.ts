// OpenAI driver: Chat Completions on both transports.
//   native  — OPENAI_API_KEY, api.openai.com
//   gateway — OPENROUTER_API_KEY, https://openrouter.ai/api/v1
// Everything vendor-specific stays here: message/tool translation, retries, model ids, usage normalisation.
import OpenAI from 'openai';
import type { Driver, Message, ToolSpec, Transport, TurnRequest, TurnResponse } from '../../core/driver.js';
import { defineDriver, type DriverOptions } from '../../core/sdk.js';

export const GATEWAY_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODELS = { native: 'gpt-5.4-mini', gateway: 'openai/gpt-5.4-mini' } as const;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAIMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text === '' ? null : m.text,
        ...(m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
          : {}),
      });
    } else {
      // Chat Completions wants one tool message per call, in order.
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.isError ? `ERROR: ${r.content}` : r.content || '(empty)' });
    }
  }
  return out;
}

export function toOpenAITools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionFunctionTool[] {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function parseArguments(raw: string): unknown {
  try {
    return raw === '' ? {} : JSON.parse(raw);
  } catch {
    return { __unparseable_arguments: raw };
  }
}

export function fromOpenAIResponse(res: OpenAI.Chat.Completions.ChatCompletion, transport: Transport): TurnResponse {
  const choice = res.choices[0];
  const message = choice?.message;
  const toolCalls = (message?.tool_calls ?? []).flatMap((c) => (c.type === 'function' ? [{ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }] : []));
  // prompt_tokens already counts cached prompt tokens (prompt_tokens_details.cached_tokens is a subset).
  const inputTokens = res.usage?.prompt_tokens ?? 0;
  const stop = toolCalls.length > 0 ? 'tool_calls' : choice?.finish_reason === 'length' ? 'length' : 'end';
  return {
    text: message?.content ?? '',
    toolCalls,
    stop,
    usage: { inputTokens, outputTokens: res.usage?.completion_tokens ?? 0, source: res.usage === undefined ? 'estimate' : 'provider' },
    transport,
    model: res.model,
  };
}

export interface OpenAIConfig {
  transport: Exclude<Transport, 'local'>;
  apiKey: string;
  model: string;
  baseURL: string;
}

export function openAIConfig(env: DriverOptions['env']): OpenAIConfig {
  const native = env.OPENAI_API_KEY ?? '';
  const gateway = env.OPENROUTER_API_KEY ?? '';
  if (native !== '') return { transport: 'native', apiKey: native, model: env.HARNESS_OPENAI_MODEL || DEFAULT_MODELS.native, baseURL: 'https://api.openai.com/v1' };
  if (gateway !== '') return { transport: 'gateway', apiKey: gateway, model: env.HARNESS_OPENAI_MODEL || DEFAULT_MODELS.gateway, baseURL: GATEWAY_BASE_URL };
  throw new Error('openai driver: no key — set OPENAI_API_KEY or OPENROUTER_API_KEY');
}

/** Reasoning models take reasoning_effort; we always ask for the lowest broadly supported level. */
const REASONING = /^(openai\/)?(gpt-5|o\d)/;

export class OpenAIDriver implements Driver {
  readonly id = 'openai';
  readonly model: string;
  private readonly client: OpenAI;

  constructor(
    readonly config: OpenAIConfig,
    private readonly log: DriverOptions['rawLog'] = () => {},
    fetchImpl?: typeof fetch,
  ) {
    this.model = config.model;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 5, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
  }

  async turn(req: TurnRequest): Promise<TurnResponse> {
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: this.config.model,
      messages: toOpenAIMessages(req.system, req.messages),
      tools: toOpenAITools(req.tools),
      max_completion_tokens: req.maxOutputTokens,
      ...(REASONING.test(this.config.model) ? { reasoning_effort: 'low' as const } : {}),
    };
    this.log?.({ dir: 'request', transport: this.config.transport, model: this.config.model, messages: body.messages.length, tools: req.tools.length });
    const res = await this.client.chat.completions.create(body);
    this.log?.({ dir: 'response', id: res.id, model: res.model, finish: res.choices[0]?.finish_reason, usage: res.usage });
    return fromOpenAIResponse(res, this.config.transport);
  }
}

export default defineDriver({
  id: 'openai',
  description: 'OpenAI via Chat Completions (native key or OpenRouter gateway)',
  envKeys: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'],
  envVars: ['HARNESS_OPENAI_MODEL'],
  create: (opts) => new OpenAIDriver(openAIConfig(opts.env), opts.rawLog),
});
