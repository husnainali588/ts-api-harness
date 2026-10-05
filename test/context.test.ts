import { describe, expect, it } from 'vitest';
import { Context, SYSTEM_PROMPT } from '../core/context.js';
import { estimateTokens } from '../core/driver.js';
import { RunState } from '../core/state.js';

function exchange(ctx: Context, n: number) {
  ctx.addAssistant('', [{ id: `c${n}`, name: 'read_file', input: { path: `f${n}.ts` } }]);
  ctx.addToolResults([{ callId: `c${n}`, content: `content of file ${n} `.repeat(50), isError: false }], { [`c${n}`]: `[read_file f${n}.ts — dropped]` });
}

describe('Context', () => {
  it('keeps the system prompt small and provider-neutral', () => {
    expect(estimateTokens(SYSTEM_PROMPT)).toBeLessThan(800);
  });

  it('puts the brief and a fresh state card first', () => {
    const state = new RunState();
    const ctx = new Context(state, { brief: 'Task: users', apiRel: 'generated/users-api', keepExchanges: 6 });
    state.recordWrite('src/a.ts');
    const [first] = ctx.render(3);
    expect(first).toMatchObject({ role: 'user' });
    expect(first?.role === 'user' ? first.content : '').toContain('State (turn 3)');
    expect(first?.role === 'user' ? first.content : '').toContain('files written: src/a.ts');
  });

  it('compacts tool results older than the last N exchanges into stubs', () => {
    const ctx = new Context(new RunState(), { brief: 'b', apiRel: 'api', keepExchanges: 2 });
    for (let n = 1; n <= 4; n += 1) exchange(ctx, n);
    const tools = ctx.render(5).filter((m) => m.role === 'tool');
    const contents = tools.map((m) => (m.role === 'tool' ? m.results[0]?.content : ''));
    expect(contents[0]).toBe('[read_file f1.ts — dropped]');
    expect(contents[1]).toBe('[read_file f2.ts — dropped]');
    expect(contents[2]).toContain('content of file 3');
    expect(contents[3]).toContain('content of file 4');
  });

  it('keeps the last 6 exchanges verbatim (no elided text) and drops large inputs only in older ones', () => {
    const ctx = new Context(new RunState(), { brief: 'b', apiRel: 'api', keepExchanges: 6 });
    const big = 'x'.repeat(5000);
    for (let n = 1; n <= 9; n += 1) {
      ctx.addAssistant('', [{ id: `w${n}`, name: 'write_file', input: { path: `f${n}.ts`, content: big } }]);
      ctx.addToolResults([{ callId: `w${n}`, content: `created f${n}.ts`, isError: false }], { [`w${n}`]: `[write_file f${n}.ts — dropped]` });
    }
    const assistants = ctx.render(10).flatMap((m) => (m.role === 'assistant' ? [m] : []));
    const window = assistants.slice(-6);
    const older = assistants.slice(0, -6);
    for (const m of window) {
      expect(m.toolCalls[0]?.input).toEqual({ path: expect.any(String), content: big });
      expect(JSON.stringify(m)).not.toMatch(/elided/);
    }
    expect(older).toHaveLength(3);
    for (const m of older) {
      expect(m.toolCalls[0]?.input).toEqual({ path: expect.any(String), _elided: '5000 chars, already applied' });
      expect(JSON.stringify(m)).not.toMatch(/chars elided from history/);
    }
  });

  it('does not compact in baseline mode and front-loads into the system prompt', () => {
    const ctx = new Context(new RunState(), { brief: 'b', apiRel: 'api', frontLoad: 'ALL THE FILES' });
    for (let n = 1; n <= 8; n += 1) exchange(ctx, n);
    expect(ctx.render(9).filter((m) => m.role === 'tool').every((m) => m.role === 'tool' && m.results[0]?.content.includes('content of file'))).toBe(true);
    expect(ctx.system()).toContain('ALL THE FILES');
  });
});
