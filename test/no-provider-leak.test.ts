// CLAUDE.md §1.1: provider/gateway names and vendor wire shapes appear only under drivers/.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './helpers.js';

export const PROVIDER_WORDS = /anthropic|openai|openrouter|claude|gpt|sonnet|opus|haiku/i;
export const WIRE_SHAPES = /input_schema|tool_use|tool_result|function_call|["']?type["']?\s*:\s*["']function["']/;

const SCANNED = ['core', 'plugins', 'tasks', 'templates', 'examples'];

export function findLeaks(root: string, dirs: readonly string[] = SCANNED): string[] {
  const leaks: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(join(root, dir))) continue;
    const files = fg.sync(`${dir}/**/*`, {
      cwd: root,
      onlyFiles: true,
      dot: true,
      ignore: ['**/node_modules/**', '**/package-lock.json'],
    });
    for (const file of files) {
      const lines = readFileSync(join(root, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const hit = PROVIDER_WORDS.exec(line) ?? WIRE_SHAPES.exec(line);
        if (hit !== null) leaks.push(`${file}:${i + 1}: "${hit[0]}"`);
      });
    }
  }
  return leaks;
}

describe('no provider leak', () => {
  it(`finds no provider names or vendor wire shapes in ${SCANNED.join(', ')}`, () => {
    expect(findLeaks(REPO_ROOT)).toEqual([]);
  });

  it('would catch a leak', () => {
    expect(PROVIDER_WORDS.test('const model = "Claude-Haiku"')).toBe(true);
    expect(WIRE_SHAPES.test('{ "type": "function", "function": {} }')).toBe(true);
    expect(WIRE_SHAPES.test('block.type === "tool_use"')).toBe(true);
  });
});
