import { describe, expect, it } from 'vitest';
import type { TurnRequest } from '../../core/driver.js';
import scripted, { ScriptedDriver, parseScript } from '../../drivers/scripted/index.js';
import { removeDir, tempDir, writeFile } from '../helpers.js';

const req: TurnRequest = { system: 'sys', messages: [{ role: 'user', content: 'go' }], tools: [], maxOutputTokens: 100 };

describe('parseScript', () => {
  it('parses script lines and skips blanks and // comments', () => {
    const turns = parseScript('// comment\n{"toolCalls":[{"name":"list_files","input":{}}]}\n\n{"text":"done"}\n');
    expect(turns).toEqual([
      { text: '', toolCalls: [{ name: 'list_files', input: {} }] },
      { text: 'done', toolCalls: [] },
    ]);
  });

  it('accepts recorded transcript lines', () => {
    const line = JSON.stringify({ turn: 1, response: { text: 'hi', toolCalls: [{ id: 'x', name: 'finish', input: {} }], stop: 'tool_calls' } });
    expect(parseScript(line)[0]?.toolCalls[0]).toEqual({ id: 'x', name: 'finish', input: {} });
  });

  it('names the line of an invalid entry', () => {
    expect(() => parseScript('{"toolCalls":[{"input":{}}]}', 's.jsonl')).toThrow(/s\.jsonl:1/);
    expect(() => parseScript('not json', 's.jsonl')).toThrow(/s\.jsonl:1: not valid JSON/);
  });
});

describe('ScriptedDriver', () => {
  it('plays tool calls in order with ids and estimated usage, then ends', async () => {
    const driver = new ScriptedDriver(parseScript('{"toolCalls":[{"name":"a","input":{"x":1}},{"name":"b","input":{}}]}'));
    const first = await driver.turn(req);
    expect(first.toolCalls.map((c) => [c.id, c.name])).toEqual([
      ['call_1_1', 'a'],
      ['call_1_2', 'b'],
    ]);
    expect(first.stop).toBe('tool_calls');
    expect(first.usage.source).toBe('estimate');
    expect(first.usage.inputTokens).toBeGreaterThan(0);
    expect(first.transport).toBe('local');
    const second = await driver.turn(req);
    expect(second).toMatchObject({ toolCalls: [], stop: 'end' });
  });

  it('is created from --script or HARNESS_SCRIPT and refuses to start without one', () => {
    const dir = tempDir('scripted');
    try {
      const path = writeFile(dir, 's.jsonl', '{"text":"hi"}\n');
      expect(scripted.create({ env: {}, script: path }).id).toBe('scripted');
      expect(scripted.create({ env: { HARNESS_SCRIPT: path } }).id).toBe('scripted');
      expect(() => scripted.create({ env: {} })).toThrow(/needs a script/);
    } finally {
      removeDir(dir);
    }
  });
});
