// Recorded-fixture tests for both live drivers on both transports. No network: fetch is faked.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnRequest } from '../../core/driver.js';
import claude, { ClaudeDriver, claudeConfig, toAnthropicMessages } from '../../drivers/claude/index.js';
import openai, { OpenAIDriver, openAIConfig, toOpenAIMessages } from '../../drivers/openai/index.js';
import { REPO_ROOT } from '../helpers.js';

const fixture = (name: string) => readFileSync(join(REPO_ROOT, 'test/fixtures/drivers', name), 'utf8');

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responses: { status: number; body: string; headers?: Record<string, string> }[]) {
  const captured: Captured[] = [];
  let i = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const parsed: unknown = JSON.parse(raw);
    captured.push({ url: String(input instanceof Request ? input.url : input), headers, body: typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {} });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return new Response(r?.body ?? '{}', { status: r?.status ?? 200, headers: { 'content-type': 'application/json', ...r?.headers } });
  };
  return { impl: impl as typeof fetch, captured };
}

const req: TurnRequest = {
  system: 'You act through tools.',
  messages: [
    { role: 'user', content: 'Task: users' },
    { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }, { id: 'c2', name: 'read_file', input: { path: 'b.ts' } }] },
    { role: 'tool', results: [{ callId: 'c1', content: 'A', isError: false }, { callId: 'c2', content: 'BLOCKED', isError: true }] },
  ],
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  maxOutputTokens: 1024,
};

describe('claude driver', () => {
  it('picks the transport from env: native key first, then the gateway, else a clear error', () => {
    expect(claudeConfig({ ANTHROPIC_API_KEY: 'n', OPENROUTER_API_KEY: 'g' })).toMatchObject({ transport: 'native', model: 'claude-sonnet-5-5' });
    expect(claudeConfig({ OPENROUTER_API_KEY: 'g' })).toMatchObject({ transport: 'gateway', model: 'anthropic/claude-sonnet-5.5', baseURL: 'https://openrouter.ai/api' });
    expect(claudeConfig({ OPENROUTER_API_KEY: 'g', HARNESS_CLAUDE_MODEL: 'anthropic/x' }).model).toBe('anthropic/x');
    expect(() => claude.create({ env: {} })).toThrow(/no key/);
  });

  it.each([
    ['native', { ANTHROPIC_API_KEY: 'sk-native-test' }, 'https://api.anthropic.com/v1/messages', 'x-api-key', 'sk-native-test'],
    ['gateway', { OPENROUTER_API_KEY: 'sk-gw-test' }, 'https://openrouter.ai/api/v1/messages', 'authorization', 'Bearer sk-gw-test'],
  ])('%s: sends Messages wire format with the right URL and auth, normalises usage incl. cache', async (transport, env, url, header, value) => {
    const fake = fakeFetch([{ status: 200, body: fixture('anthropic-message.json') }]);
    const driver = new ClaudeDriver(claudeConfig(env), () => {}, fake.impl);
    const res = await driver.turn(req);
    const sent = fake.captured[0];
    expect(sent?.url).toBe(url);
    expect(sent?.headers[header]).toBe(value);
    expect(sent?.body.max_tokens).toBe(1024);
    expect(sent?.body.system).toBe('You act through tools.');
    expect(sent?.body).not.toHaveProperty('temperature');
    expect(sent?.body.tools).toEqual([{ name: 'read_file', description: 'Read a file', input_schema: req.tools[0]?.inputSchema }]);
    expect(res.toolCalls).toEqual([
      { id: 'toolu_01A', name: 'get_task', input: {} },
      { id: 'toolu_01B', name: 'list_files', input: { dir: 'src' } },
    ]);
    expect(res.usage).toEqual({ inputTokens: 2000, outputTokens: 85, source: 'provider' });
    expect(res).toMatchObject({ stop: 'tool_calls', transport, model: 'claude-haiku-4-5-20251001', text: "I'll read the task first." });
  });

  it('batches parallel tool results into one user message with tool_result blocks', () => {
    const msgs = toAnthropicMessages(req.messages);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2]?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'A', is_error: false },
      { type: 'tool_result', tool_use_id: 'c2', content: 'BLOCKED', is_error: true },
    ]);
  });

  it('retries a 429 with backoff', async () => {
    const fake = fakeFetch([
      { status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', headers: { 'retry-after-ms': '1' } },
      { status: 200, body: fixture('anthropic-message.json') },
    ]);
    const res = await new ClaudeDriver(claudeConfig({ OPENROUTER_API_KEY: 'k' }), () => {}, fake.impl).turn(req);
    expect(fake.captured).toHaveLength(2);
    expect(res.toolCalls).toHaveLength(2);
  });
});

describe('openai driver', () => {
  it('picks the transport from env: native key first, then the gateway, else a clear error', () => {
    expect(openAIConfig({ OPENAI_API_KEY: 'n', OPENROUTER_API_KEY: 'g' })).toMatchObject({ transport: 'native', model: 'gpt-5.4-mini' });
    expect(openAIConfig({ OPENROUTER_API_KEY: 'g' })).toMatchObject({ transport: 'gateway', model: 'openai/gpt-5.4-mini', baseURL: 'https://openrouter.ai/api/v1' });
    expect(() => openai.create({ env: {} })).toThrow(/no key/);
  });

  it.each([
    ['native', { OPENAI_API_KEY: 'sk-native-test' }, 'https://api.openai.com/v1/chat/completions', 'Bearer sk-native-test'],
    ['gateway', { OPENROUTER_API_KEY: 'sk-gw-test' }, 'https://openrouter.ai/api/v1/chat/completions', 'Bearer sk-gw-test'],
  ])('%s: sends Chat Completions with the right URL and auth, normalises usage', async (transport, env, url, auth) => {
    const fake = fakeFetch([{ status: 200, body: fixture('openai-completion.json') }]);
    const res = await new OpenAIDriver(openAIConfig(env), () => {}, fake.impl).turn(req);
    const sent = fake.captured[0];
    expect(sent?.url).toBe(url);
    expect(sent?.headers.authorization).toBe(auth);
    expect(sent?.body.max_completion_tokens).toBe(1024);
    expect(sent?.body.reasoning_effort).toBe('low');
    expect(sent?.body).not.toHaveProperty('temperature');
    expect(sent?.body).not.toHaveProperty('max_tokens');
    expect(sent?.body.tools).toEqual([{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: req.tools[0]?.inputSchema } }]);
    expect(res.toolCalls).toEqual([
      { id: 'call_A', name: 'get_task', input: {} },
      { id: 'call_B', name: 'list_files', input: { dir: 'src' } },
    ]);
    // prompt_tokens already includes the 1024 cached tokens.
    expect(res.usage).toEqual({ inputTokens: 2000, outputTokens: 90, source: 'provider' });
    expect(res).toMatchObject({ stop: 'tool_calls', transport, model: 'gpt-5.4-mini-2026-03-17' });
  });

  it('sends one tool message per result, in order', () => {
    const msgs = toOpenAIMessages('sys', req.messages);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
    expect(msgs[4]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'ERROR: BLOCKED' });
  });

  it('retries a 429 with backoff', async () => {
    const fake = fakeFetch([
      { status: 429, body: '{"error":{"message":"rate limited"}}', headers: { 'retry-after-ms': '1' } },
      { status: 200, body: fixture('openai-completion.json') },
    ]);
    const res = await new OpenAIDriver(openAIConfig({ OPENROUTER_API_KEY: 'k' }), () => {}, fake.impl).turn(req);
    expect(fake.captured).toHaveLength(2);
    expect(res.toolCalls).toHaveLength(2);
  });
});
